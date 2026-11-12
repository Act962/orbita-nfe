import { createHash } from 'node:crypto';
import type { AuditContext, CompanyAuditAction } from '../../../shared/application/audit.js';
import { BusinessRuleError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { retryDelaySeconds } from '../../../shared/domain/backoff.js';
import { DEFAULT_RECONCILIATION_POLICY, type ReconciliationPolicy } from '../domain/reconciliation.js';
import { recoverStuck, type ServiceInvoiceStatus } from '../domain/service-invoice.js';
import { scheduleFirstEscalation } from './unknown-escalator.js';
import type { CredentialAccess, DpsPreparer, IssuerCredential, NfseGateway, NfseWorkerRepositories, ServiceInvoice, SubmissionOutcome } from './ports.js';

export interface ProcessorOptions {
  /** Concessão do processamento; maior que o tempo máximo de uma transmissão. */
  readonly leaseMs: number;
  readonly reconciliation: ReconciliationPolicy;
  /** Espera antes de reenviar depois de NOT_SENT (backoff por tentativa). */
  readonly notSentBackoff: { readonly baseSeconds: number; readonly maxSeconds: number; readonly jitter: number };
}

export const DEFAULT_PROCESSOR_OPTIONS: ProcessorOptions = {
  leaseMs: 120_000,
  reconciliation: DEFAULT_RECONCILIATION_POLICY,
  notSentBackoff: { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 },
};

export type ProcessResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'LEASED' | 'NOT_PENDING'; readonly status?: ServiceInvoiceStatus }
  | { readonly kind: 'FAILED'; readonly code: string }
  /** Falha local numa retransmissão (já houve envio): o job deve tentar de novo depois. Nunca FAILED. */
  | { readonly kind: 'DEFERRED'; readonly code: string }
  | { readonly kind: 'TRANSMITTED'; readonly outcome: SubmissionOutcome['kind'] };

/**
 * Transmissão de uma NFS-e pelo worker-fiscal com registro prévio (ADR-0022, ADR-0032 item 4):
 *
 *   TX1  PENDING → PROCESSING (concessão)
 *   ---  certificado (L5) + DPS assinada (só na 1ª vez; depois, sempre os mesmos bytes)
 *   TX1b tentativa PREPARED
 *   TX2  tentativa SENDING  ← commit ANTES da rede
 *   ---  gateway.submit
 *   TX3  resultado
 *
 * O handler é idempotente: rodar de novo relê o estado. Um PROCESSING com a concessão vencida
 * é uma queda; a tentativa aberta decide (doc 12 §2): PREPARED → PENDING; SENDING → UNKNOWN.
 */
export class SubmissionProcessor {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly credentials: CredentialAccess,
    private readonly preparer: DpsPreparer,
    private readonly gateway: NfseGateway,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
    private readonly options: ProcessorOptions = DEFAULT_PROCESSOR_OPTIONS,
  ) {}

  async process(companyId: string, invoiceId: string, context: AuditContext): Promise<ProcessResult> {
    const recovered = await this.recoverIfStuck(companyId, invoiceId, context);
    if (recovered !== undefined) return recovered;

    // TX1: trava L5 de produção e concessão.
    const claimed = await this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (invoice.status !== 'PENDING') return { kind: 'SKIPPED', reason: 'NOT_PENDING', status: invoice.status } as const;
      if (invoice.environment === 'PRODUCTION' && !(await r.production.isEnabled(invoice.establishmentId))) {
        return this.failOrDefer(r, invoice, 'PENDING', 'PRODUCTION_NOT_ENABLED', context);
      }
      const leaseUntil = new Date(this.now().getTime() + this.options.leaseMs);
      if (!(await r.invoices.changeStatus(invoice.id, 'PENDING', 'PROCESSING', { leaseUntil }))) {
        return { kind: 'SKIPPED', reason: 'NOT_PENDING' } as const;
      }
      return invoice;
    });
    if ('kind' in claimed) return claimed;

    try {
      return await this.credentials.withCredential(companyId, claimed.establishmentId, (credential) =>
        this.transmit(companyId, claimed, credential, context),
      );
    } catch (error) {
      // Certificado ausente ou vencido (L5): lançado antes do callback, nada foi enviado.
      if (error instanceof BusinessRuleError && error.code.startsWith('CERTIFICATE_')) {
        return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, claimed, 'PROCESSING', error.code, context));
      }
      throw error;
    }
  }

  private async transmit(
    companyId: string,
    invoice: ServiceInvoice,
    credential: IssuerCredential,
    context: AuditContext,
  ): Promise<ProcessResult> {
    // Preparação: a DPS é assinada uma única vez. Retransmissão usa os bytes gravados.
    let signed = invoice.signedDpsSha256 === null ? undefined : await this.uow.inCompany(companyId, (r) => r.invoices.signedDps(invoice.id));
    let newSignature: { xml: string; sha256: string; layoutPackage: string } | undefined;
    if (signed === undefined) {
      const prepared = await this.preparer.prepare(invoice, credential);
      if (!prepared.ok) return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, invoice, 'PROCESSING', prepared.code, context));
      signed = prepared.signedXml;
      newSignature = { xml: signed, sha256: sha256(signed), layoutPackage: prepared.layoutPackage };
    }
    const payloadSha256 = sha256(signed);
    if (invoice.signedDpsSha256 !== null && invoice.signedDpsSha256 !== payloadSha256) throw new Error('SIGNED_DPS_HASH_MISMATCH');

    // TX1b: grava a DPS assinada (1ª vez) e a tentativa PREPARED.
    const attempt = await this.uow.inCompany(companyId, async (r) => {
      if (newSignature !== undefined) await r.invoices.storeSignedDps(invoice.id, newSignature);
      const last = await r.attempts.last(invoice.id);
      return r.attempts.insert({ id: this.newId(), companyId, invoiceId: invoice.id, seq: (last?.seq ?? 0) + 1, payloadSha256 });
    });

    // TX2: SENDING com commit antes da rede. Daqui em diante, qualquer dúvida é UNKNOWN.
    const sendingAt = this.now();
    await this.uow.inCompany(companyId, (r) => r.attempts.markSending(attempt.id, sendingAt));

    let outcome: SubmissionOutcome;
    try {
      outcome = await this.gateway.submit(signed, { environment: invoice.environment, credential });
    } catch {
      // Exceção inesperada do adapter depois do SENDING: não há prova de que não saiu.
      outcome = { kind: 'UNKNOWN', errorCode: 'GATEWAY_EXCEPTION' };
    }

    // TX3: resultado.
    await this.uow.inCompany(companyId, async (r) => {
      const at = this.now();
      switch (outcome.kind) {
        case 'AUTHORIZED':
          await r.attempts.close(attempt.id, 'AUTHORIZED', null, at);
          await this.settle(r, invoice, 'PROCESSING', 'AUTHORIZED', context, {
            leaseUntil: null,
            authorization: { accessKey: outcome.accessKey, nfseXml: outcome.nfseXml, authorizedAt: at },
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
            queue: 'nfse.process',
            payload: { companyId, invoiceId: invoice.id },
            singletonKey: `${invoice.id}:resend:${attempt.seq}`,
            runAt: new Date(at.getTime() + delay * 1000),
            correlationId: context.correlationId,
          });
          return;
        }
        case 'UNKNOWN':
        case 'ALREADY_EXISTS':
          await r.attempts.close(attempt.id, outcome.kind, outcome.kind === 'UNKNOWN' ? outcome.errorCode : null, at);
          await this.settle(r, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null });
          // Duplicidade: a DPS existe lá; consulta já. Senão, respeita a espera mínima.
          await this.scheduleLookup(r, companyId, invoice.id, attempt.seq, 0, outcome.kind === 'ALREADY_EXISTS' ? at : new Date(sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs), context);
          await scheduleFirstEscalation(r.jobs, { companyId, invoiceId: invoice.id, attemptSeq: attempt.seq, since: sendingAt, correlationId: context.correlationId });
          return;
      }
    });
    return { kind: 'TRANSMITTED', outcome: outcome.kind };
  }

  /** Queda com concessão vencida: aplica a tabela do doc 12 §2. */
  private async recoverIfStuck(companyId: string, invoiceId: string, context: AuditContext): Promise<ProcessResult | undefined> {
    return this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (invoice.status !== 'PROCESSING') return undefined;
      if (invoice.leaseUntil !== null && invoice.leaseUntil.getTime() > this.now().getTime()) return { kind: 'SKIPPED', reason: 'LEASED' } as const;

      const open = await r.attempts.open(invoice.id);
      const at = this.now();
      const recovery = recoverStuck(open?.state ?? null);
      if (recovery.kind === 'TO_UNKNOWN' && open !== undefined) {
        await r.attempts.close(open.id, 'RECOVERED_UNKNOWN', null, at);
        await this.settle(r, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null });
        const sendingAt = open.sendingAt ?? at;
        await this.scheduleLookup(r, companyId, invoice.id, open.seq, 0, new Date(sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs), context);
        await scheduleFirstEscalation(r.jobs, { companyId, invoiceId: invoice.id, attemptSeq: open.seq, since: sendingAt, correlationId: context.correlationId });
        return { kind: 'TRANSMITTED', outcome: 'UNKNOWN' } as const;
      }
      if (open !== undefined) await r.attempts.close(open.id, 'RECOVERED_NOT_SENT', null, at);
      await r.invoices.changeStatus(invoice.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
      return undefined; // segue o fluxo normal a partir de PENDING
    });
  }

  /**
   * Falha local antes do envio. FAILED só se NENHUMA tentativa chegou a SENDING; numa
   * retransmissão (já houve envio), o documento volta a PENDING e o job tenta de novo depois:
   * nunca se perde a chance de reconciliar uma nota que pode existir.
   */
  private async failOrDefer(
    r: NfseWorkerRepositories,
    invoice: ServiceInvoice,
    from: 'PENDING' | 'PROCESSING',
    code: string,
    context: AuditContext,
  ): Promise<ProcessResult> {
    if (await r.attempts.anySent(invoice.id)) {
      if (from === 'PROCESSING') await r.invoices.changeStatus(invoice.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
      return { kind: 'DEFERRED', code };
    }
    await this.settle(r, invoice, from, 'FAILED', context, { leaseUntil: null, failureCode: code });
    return { kind: 'FAILED', code };
  }

  private async settle(
    r: NfseWorkerRepositories,
    invoice: ServiceInvoice,
    from: ServiceInvoiceStatus,
    to: 'AUTHORIZED' | 'REJECTED' | 'FAILED' | 'UNKNOWN',
    context: AuditContext,
    change: Parameters<NfseWorkerRepositories['invoices']['changeStatus']>[3],
  ): Promise<void> {
    if (!(await r.invoices.changeStatus(invoice.id, from, to, change))) throw new Error('SERVICE_INVOICE_CONCURRENT_CHANGE');
    await publishStatus(r, invoice, to, context, {
      ...(change?.rejection === undefined ? {} : { rejectionCode: change.rejection.code }),
      ...(change?.failureCode === undefined ? {} : { failureCode: change.failureCode }),
    });
  }

  private async scheduleLookup(r: NfseWorkerRepositories, companyId: string, invoiceId: string, seq: number, lookup: number, runAt: Date, context: AuditContext): Promise<void> {
    await r.jobs.enqueue({
      queue: 'nfse.reconcile',
      payload: { companyId, invoiceId },
      singletonKey: `${invoiceId}:lookup:${seq}:${lookup}`,
      runAt,
      correlationId: context.correlationId,
    });
  }
}

const AUDIT_BY_STATUS: Record<'AUTHORIZED' | 'REJECTED' | 'FAILED' | 'UNKNOWN', CompanyAuditAction> = {
  AUTHORIZED: 'service_invoice.authorized',
  REJECTED: 'service_invoice.rejected',
  FAILED: 'service_invoice.failed',
  UNKNOWN: 'service_invoice.unknown',
};

/** Auditoria + webhook `service_invoice.status_changed` na mesma transação da mudança. */
export async function publishStatus(
  r: Pick<NfseWorkerRepositories, 'audit' | 'events'>,
  invoice: ServiceInvoice,
  status: 'AUTHORIZED' | 'REJECTED' | 'FAILED' | 'UNKNOWN',
  context: AuditContext,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  await r.audit.record(context, { action: AUDIT_BY_STATUS[status], subject: { type: 'service_invoice', id: invoice.id }, details: { dpsId: invoice.dpsId, ...extra } });
  await r.events.publish({
    type: 'service_invoice.status_changed',
    subject: { type: 'service_invoice', id: invoice.id },
    data: {
      serviceInvoiceId: invoice.id,
      establishmentId: invoice.establishmentId,
      externalReference: invoice.externalReference,
      environment: invoice.environment,
      status,
      ...extra,
    },
    correlationId: context.correlationId,
  });
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
