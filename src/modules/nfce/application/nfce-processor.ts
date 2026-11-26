import { createHash } from 'node:crypto';
import type { AuditContext, CompanyAuditAction } from '../../../shared/application/audit.js';
import { BusinessRuleError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { retryDelaySeconds } from '../../../shared/domain/backoff.js';
import { DEFAULT_RECONCILIATION_POLICY, type ReconciliationPolicy } from '../../../shared/domain/reconciliation.js';
import { recoverStuck, type ConsumerInvoiceStatus } from '../domain/consumer-invoice.js';
import type {
  ConsumerInvoice,
  ConsumerInvoiceStatusChange,
  NfceAuthorizerGateway,
  NfceCredential,
  NfceCredentialAccess,
  NfceEmitterReader,
  NfcePreparer,
  NfceSubmission,
  NfceWorkerRepositories,
} from './ports.js';

export interface NfceProcessorOptions {
  /** Concessão do processamento; maior que o tempo máximo de uma transmissão. */
  readonly leaseMs: number;
  readonly reconciliation: ReconciliationPolicy;
  /** Espera antes de uma nova tentativa depois de NOT_SENT (backoff por tentativa). */
  readonly notSentBackoff: { readonly baseSeconds: number; readonly maxSeconds: number; readonly jitter: number };
}

export const DEFAULT_NFCE_PROCESSOR_OPTIONS: NfceProcessorOptions = {
  leaseMs: 120_000,
  reconciliation: DEFAULT_RECONCILIATION_POLICY,
  notSentBackoff: { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 },
};

export type NfceProcessResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'LEASED' | 'NOT_PENDING'; readonly status?: ConsumerInvoiceStatus }
  | { readonly kind: 'FAILED'; readonly code: string }
  /** Falha local depois de um envio anterior: o job tenta de novo. Nunca FAILED. */
  | { readonly kind: 'DEFERRED'; readonly code: string }
  | { readonly kind: 'TRANSMITTED'; readonly outcome: NfceSubmission['kind'] };

/** Monta o `nfeProc` (NFe + protNFe) da nota autorizada. */
export type NfeProcBuilder = (signedXml: string, protocolXml: string) => string;

/**
 * Transmissão de uma NFC-e pelo worker-fiscal com registro prévio (ADR-0072, ADR-0022):
 *
 *   TX1  PENDING → PROCESSING (concessão)
 *   ---  emitente do cadastro + certificado + XML montado e assinado AGORA (dhEmi; regra B09-40)
 *   TX1b tentativa PREPARED, com o XML, a chave e o digest
 *   TX2  tentativa SENDING  ← commit ANTES da rede
 *   ---  gateway.submit
 *   TX3  resultado (ADR-0070)
 *
 * Uma tentativa nova só nasce com a nota em PENDING, e a nota só volta a PENDING quando está provado
 * que nada foi gravado no autorizador (NOT_SENT, queda em PREPARED, ou a reconciliação).
 */
export class NfceSubmissionProcessor {
  constructor(
    private readonly uow: UnitOfWork<NfceWorkerRepositories>,
    private readonly emitters: NfceEmitterReader,
    private readonly credentials: NfceCredentialAccess,
    private readonly preparer: NfcePreparer,
    private readonly gateway: NfceAuthorizerGateway,
    private readonly nfeProc: NfeProcBuilder,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
    private readonly options: NfceProcessorOptions = DEFAULT_NFCE_PROCESSOR_OPTIONS,
  ) {}

  async process(companyId: string, invoiceId: string, context: AuditContext): Promise<NfceProcessResult> {
    const recovered = await this.recoverIfStuck(companyId, invoiceId, context);
    if (recovered !== undefined) return recovered;

    const claimed = await this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (invoice.status !== 'PENDING') return { kind: 'SKIPPED', reason: 'NOT_PENDING', status: invoice.status } as const;
      if (invoice.environment === 'PRODUCTION' && !(await r.production.isEnabled(invoice.establishmentId))) {
        return this.failOrDefer(r, invoice, 'PENDING', 'PRODUCTION_NOT_ENABLED', context);
      }
      const leaseUntil = new Date(this.now().getTime() + this.options.leaseMs);
      if (!(await r.invoices.changeStatus(invoice.id, 'PENDING', 'PROCESSING', { leaseUntil }))) return { kind: 'SKIPPED', reason: 'NOT_PENDING' } as const;
      return invoice;
    });
    if ('kind' in claimed) return claimed;

    const emitter = await this.emitters.emitter(companyId, claimed.establishmentId);
    if (!emitter.ok) return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, claimed, 'PROCESSING', emitter.code, context));

    try {
      return await this.credentials.withCredential(companyId, claimed.establishmentId, (credential) => this.transmit(companyId, claimed, emitter.emitter, credential, context));
    } catch (error) {
      // Certificado ausente ou vencido: lançado antes do callback, nada foi enviado.
      if (error instanceof BusinessRuleError && error.code.startsWith('CERTIFICATE_')) {
        return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, claimed, 'PROCESSING', error.code, context));
      }
      throw error;
    }
  }

  private async transmit(
    companyId: string,
    invoice: ConsumerInvoice,
    emitter: Parameters<NfcePreparer['prepare']>[1],
    credential: NfceCredential,
    context: AuditContext,
  ): Promise<NfceProcessResult> {
    // XML novo a cada tentativa, com dhEmi agora (B09-40: até 5 minutos até a SEFAZ).
    const issuedAt = this.now();
    const prepared = await this.preparer.prepare(invoice, emitter, credential, issuedAt);
    if (!prepared.ok) return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, invoice, 'PROCESSING', prepared.code, context));
    const expected = { accessKey: prepared.accessKey, digestValue: prepared.digestValue };

    const attempt = await this.uow.inCompany(companyId, async (r) => {
      const last = await r.attempts.last(invoice.id);
      return r.attempts.insert({
        id: this.newId(),
        companyId,
        invoiceId: invoice.id,
        seq: (last?.seq ?? 0) + 1,
        accessKey: prepared.accessKey,
        issuedAt,
        signedXml: prepared.signedXml,
        payloadSha256: sha256(prepared.signedXml),
        digestValue: prepared.digestValue,
      });
    });

    // TX2: SENDING com commit antes da rede. Daqui em diante, qualquer dúvida é UNKNOWN.
    const sendingAt = this.now();
    await this.uow.inCompany(companyId, (r) => r.attempts.markSending(attempt.id, sendingAt));

    let outcome: NfceSubmission;
    try {
      outcome = await this.gateway.submit(prepared.signedXml, expected, { environment: invoice.environment, credential });
    } catch {
      outcome = { kind: 'UNKNOWN', errorCode: 'GATEWAY_EXCEPTION' };
    }

    await this.uow.inCompany(companyId, async (r) => {
      const at = this.now();
      switch (outcome.kind) {
        case 'AUTHORIZED':
          await r.attempts.close(attempt.id, 'AUTHORIZED', outcome.statusCode, at);
          await this.settle(r, invoice, 'PROCESSING', 'AUTHORIZED', context, {
            leaseUntil: null,
            settled: {
              accessKey: prepared.accessKey,
              statusCode: outcome.statusCode,
              protocolNumber: outcome.protocolNumber,
              at: outcome.authorizedAt,
              nfeProcXml: this.nfeProc(prepared.signedXml, outcome.protocolXml),
            },
          });
          return;
        case 'DENIED':
          await r.attempts.close(attempt.id, 'DENIED', outcome.statusCode, at);
          await this.settle(r, invoice, 'PROCESSING', 'DENIED', context, {
            leaseUntil: null,
            settled: { accessKey: prepared.accessKey, statusCode: outcome.statusCode, protocolNumber: outcome.protocolNumber, at },
          });
          return;
        case 'REJECTED':
          await r.attempts.close(attempt.id, 'REJECTED', outcome.code, at);
          await this.settle(r, invoice, 'PROCESSING', 'REJECTED', context, { leaseUntil: null, rejection: { code: outcome.code, message: outcome.message } });
          return;
        case 'NOT_SENT': {
          await r.attempts.close(attempt.id, 'NOT_SENT', outcome.errorCode, at);
          await r.invoices.changeStatus(invoice.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
          const delay = retryDelaySeconds(attempt.seq, this.options.notSentBackoff);
          await r.jobs.enqueue({
            queue: 'nfce.process',
            payload: { companyId, invoiceId: invoice.id },
            singletonKey: `${invoice.id}:resend:${String(attempt.seq)}`,
            runAt: new Date(at.getTime() + delay * 1000),
            correlationId: context.correlationId,
          });
          return;
        }
        case 'UNKNOWN':
        case 'ALREADY_EXISTS':
          await r.attempts.close(attempt.id, outcome.kind, outcome.kind === 'UNKNOWN' ? outcome.errorCode : outcome.code, at);
          await this.settle(r, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null });
          // Duplicidade: a chave (ou o número) existe lá; consulta já. Senão, a espera mínima.
          await scheduleLookup(r, companyId, invoice.id, attempt.seq, 0, outcome.kind === 'ALREADY_EXISTS' ? at : new Date(sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs), context);
          return;
      }
    });
    return { kind: 'TRANSMITTED', outcome: outcome.kind };
  }

  /** Queda com concessão vencida (doc 12 §2): PREPARED → PENDING; SENDING → UNKNOWN. */
  private async recoverIfStuck(companyId: string, invoiceId: string, context: AuditContext): Promise<NfceProcessResult | undefined> {
    return this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (invoice.status !== 'PROCESSING') return undefined;
      if (invoice.leaseUntil !== null && invoice.leaseUntil.getTime() > this.now().getTime()) return { kind: 'SKIPPED', reason: 'LEASED' } as const;

      const open = await r.attempts.open(invoice.id);
      const at = this.now();
      if (recoverStuck(open?.state ?? null).kind === 'TO_UNKNOWN' && open !== undefined) {
        await r.attempts.close(open.id, 'RECOVERED_UNKNOWN', null, at);
        await this.settle(r, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null });
        const sendingAt = open.sendingAt ?? at;
        await scheduleLookup(r, companyId, invoice.id, open.seq, 0, new Date(sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs), context);
        return { kind: 'TRANSMITTED', outcome: 'UNKNOWN' } as const;
      }
      if (open !== undefined) await r.attempts.close(open.id, 'RECOVERED_NOT_SENT', null, at);
      await r.invoices.changeStatus(invoice.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
      return undefined;
    });
  }

  /** Falha local antes do envio: FAILED só se nenhuma tentativa chegou a SENDING. */
  private async failOrDefer(r: NfceWorkerRepositories, invoice: ConsumerInvoice, from: 'PENDING' | 'PROCESSING', code: string, context: AuditContext): Promise<NfceProcessResult> {
    if (await r.attempts.anySent(invoice.id)) {
      if (from === 'PROCESSING') await r.invoices.changeStatus(invoice.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
      return { kind: 'DEFERRED', code };
    }
    await this.settle(r, invoice, from, 'FAILED', context, { leaseUntil: null, failureCode: code });
    return { kind: 'FAILED', code };
  }

  private async settle(
    r: NfceWorkerRepositories,
    invoice: ConsumerInvoice,
    from: ConsumerInvoiceStatus,
    to: 'AUTHORIZED' | 'REJECTED' | 'DENIED' | 'FAILED' | 'UNKNOWN',
    context: AuditContext,
    change: ConsumerInvoiceStatusChange,
  ): Promise<void> {
    if (!(await r.invoices.changeStatus(invoice.id, from, to, change))) throw new Error('CONSUMER_INVOICE_CONCURRENT_CHANGE');
    await recordStatus(r, invoice, to, context, {
      ...(change.rejection === undefined ? {} : { rejectionCode: change.rejection.code }),
      ...(change.failureCode === undefined ? {} : { failureCode: change.failureCode }),
      ...(change.settled === undefined ? {} : { statusCode: change.settled.statusCode }),
    });
  }
}

const AUDIT_BY_STATUS: Record<'AUTHORIZED' | 'REJECTED' | 'DENIED' | 'FAILED' | 'UNKNOWN', CompanyAuditAction> = {
  AUTHORIZED: 'consumer_invoice.authorized',
  REJECTED: 'consumer_invoice.rejected',
  DENIED: 'consumer_invoice.denied',
  FAILED: 'consumer_invoice.failed',
  UNKNOWN: 'consumer_invoice.unknown',
};

/** Auditoria da mudança, na mesma transação. Os webhooks da NFC-e entram com o seu próprio ADR. */
export async function recordStatus(
  r: Pick<NfceWorkerRepositories, 'audit'>,
  invoice: ConsumerInvoice,
  status: keyof typeof AUDIT_BY_STATUS,
  context: AuditContext,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  await r.audit.record(context, { action: AUDIT_BY_STATUS[status], subject: { type: 'consumer_invoice', id: invoice.id }, details: { series: invoice.series, number: invoice.number, ...extra } });
}

export async function scheduleLookup(
  r: Pick<NfceWorkerRepositories, 'jobs'>,
  companyId: string,
  invoiceId: string,
  seq: number,
  lookup: number | string,
  runAt: Date,
  context: AuditContext,
): Promise<void> {
  await r.jobs.enqueue({ queue: 'nfce.reconcile', payload: { companyId, invoiceId }, singletonKey: `${invoiceId}:lookup:${String(seq)}:${String(lookup)}`, runAt, correlationId: context.correlationId });
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
