import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { blocksNotIssued, checkResolutionInput, type ResolutionOutcome } from '../domain/manual-resolution.js';
import type {
  NfseDeskReader,
  NfseDeskRepositories,
  NfseDocumentVerifier,
  NfseWorkerRepositories,
  ServiceInvoiceResolution,
  UnknownInvoiceSummary,
} from './ports.js';
import { publishStatus } from './submission-processor.js';

export interface ResolutionRequest {
  /** Empresa informada pelo operador; a nota é procurada só no contexto dela (RLS). */
  readonly companyId: string;
  readonly invoiceId: string;
  readonly outcome: string;
  readonly reason: string;
  /** XML oficial da NFS-e obtido no portal: obrigatório em AUTHORIZED, proibido em NOT_ISSUED. */
  readonly nfseXml: string | null;
  /** SHA-256 do arquivo de evidência guardado pelo operador (NOT_ISSUED). Em AUTHORIZED, é o do XML. */
  readonly evidenceSha256: string | null;
  readonly operator: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Código interno da corrida no índice de pedido aberto (constraint → ConflictError). */
export const RESOLUTION_ALREADY_REQUESTED = 'RESOLUTION_ALREADY_REQUESTED';

/**
 * Balcão do operador (CLI ops, papel fiscal_admin): painel de pendências e pedido de resolução.
 * Só GRAVA o pedido, audita e enfileira `nfse.resolve`; quem confere e muda o documento é o
 * worker-fiscal (ResolutionApplier).
 */
export class ManualResolutionDesk {
  constructor(
    private readonly uow: UnitOfWork<NfseDeskRepositories>,
    private readonly reader: NfseDeskReader,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Notas em UNKNOWN há pelo menos `minAgeMs`, das mais antigas para as mais novas. Sem
   * `companyId`, percorre as empresas que têm reconciliação na fila, uma transação por empresa.
   */
  async listUnknown(minAgeMs: number, limit: number, companyId?: string): Promise<readonly UnknownInvoiceSummary[]> {
    const sinceBefore = new Date(this.now().getTime() - minAgeMs);
    const companies = companyId === undefined ? await this.reader.companiesWithReconciliation() : [companyId];
    const found: UnknownInvoiceSummary[] = [];
    for (const company of companies) found.push(...(await this.reader.listUnknown(company, sinceBefore, limit)));
    return found.sort((a, b) => a.since.getTime() - b.since.getTime()).slice(0, limit);
  }

  async status(companyId: string, resolutionId: string): Promise<ServiceInvoiceResolution> {
    const found = await this.reader.findResolution(companyId, resolutionId);
    if (found === undefined) throw new NotFoundError('RESOLUTION_NOT_FOUND', 'Pedido de resolução não encontrado.');
    return found;
  }

  async request(input: ResolutionRequest, context: AuditContext): Promise<ServiceInvoiceResolution> {
    const checked = checkResolutionInput(input);
    if (!checked.ok) throw new ValidationFailedError([{ code: checked.error, message: RESOLUTION_INPUT_MESSAGES[checked.error] }], 'Pedido de resolução inválido.');
    const outcome: ResolutionOutcome = checked.value;
    const evidenceSha256 = outcome === 'AUTHORIZED' ? sha256(input.nfseXml ?? '') : input.evidenceSha256;
    if (evidenceSha256 === null || !SHA256_HEX.test(evidenceSha256)) {
      throw new ValidationFailedError([{ code: 'EVIDENCE_REQUIRED', message: 'Informe a evidência (arquivo) da inexistência da nota.' }], 'Pedido de resolução inválido.');
    }

    const invoice = await this.reader.findInvoice(input.companyId, input.invoiceId);
    if (invoice === undefined) throw new NotFoundError('SERVICE_INVOICE_NOT_FOUND', 'NFS-e não encontrada.');
    if (invoice.status !== 'UNKNOWN') {
      throw new BusinessRuleError('SERVICE_INVOICE_NOT_UNKNOWN', `A NFS-e está em ${invoice.status}: só nota em UNKNOWN tem resolução manual.`);
    }

    try {
      return await this.uow.inCompany(invoice.companyId, async (r) => {
        const resolution = await r.resolutions.insert({
          id: this.newId(),
          companyId: invoice.companyId,
          invoiceId: invoice.id,
          outcome,
          reason: input.reason.trim(),
          evidenceSha256,
          nfseXml: outcome === 'AUTHORIZED' ? input.nfseXml : null,
          operator: input.operator,
        });
        await r.audit.record(context, {
          action: 'service_invoice.resolution_requested',
          subject: { type: 'service_invoice', id: invoice.id },
          details: { resolutionId: resolution.id, outcome, evidenceSha256, operator: input.operator },
        });
        await r.jobs.enqueue({
          queue: 'nfse.resolve',
          payload: { companyId: invoice.companyId, resolutionId: resolution.id },
          singletonKey: resolution.id,
          correlationId: context.correlationId,
        });
        return resolution;
      });
    } catch (error) {
      if (error instanceof ConflictError && error.code === RESOLUTION_ALREADY_REQUESTED) {
        throw new ConflictError(RESOLUTION_ALREADY_REQUESTED, 'Já há um pedido de resolução aberto para esta NFS-e. Acompanhe-o antes de pedir outro.');
      }
      throw error;
    }
  }
}

const RESOLUTION_INPUT_MESSAGES = {
  OUTCOME_INVALID: 'Resultado deve ser AUTHORIZED ou NOT_ISSUED.',
  REASON_TOO_SHORT: 'Justificativa com pelo menos 10 caracteres.',
  REASON_TOO_LONG: 'Justificativa com no máximo 2000 caracteres.',
  NFSE_XML_REQUIRED: 'AUTHORIZED exige o XML oficial da NFS-e obtido no portal.',
  NFSE_XML_NOT_ALLOWED: 'NOT_ISSUED não leva XML de NFS-e.',
} as const;

export type ApplyResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'ALREADY_DECIDED' }
  | { readonly kind: 'APPLIED'; readonly outcome: ResolutionOutcome }
  | { readonly kind: 'REFUSED'; readonly code: string };

/**
 * Aplica o pedido no worker-fiscal (ADR-0034 item 3):
 *
 * - AUTHORIZED: confere o XML oficial (XSD, Id da DPS, ambiente, assinatura da DPS) e faz
 *   UNKNOWN → AUTHORIZED com a chave e o XML. Webhook `AUTHORIZED` com `resolvedBy: MANUAL`.
 * - NOT_ISSUED: UNKNOWN → PENDING e retransmite o MESMO XML assinado. Recusado se o
 *   autorizador já respondeu duplicidade nesta nota.
 *
 * Qualquer recusa grava o código, audita e deixa o documento em UNKNOWN: a reconciliação
 * automática continua.
 */
export class ResolutionApplier {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly verifier: NfseDocumentVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async apply(companyId: string, resolutionId: string, context: AuditContext): Promise<ApplyResult> {
    const loaded = await this.uow.inCompany(companyId, async (r) => {
      const resolution = await r.resolutions.find(resolutionId);
      if (resolution === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (resolution.state !== 'REQUESTED') return { kind: 'SKIPPED', reason: 'ALREADY_DECIDED' } as const;
      const invoice = await r.invoices.findById(resolution.invoiceId);
      if (invoice === undefined) throw new Error('pedido de resolução sem documento');
      const last = await r.attempts.last(invoice.id);
      const signedDps = resolution.outcome === 'AUTHORIZED' ? await r.invoices.signedDps(invoice.id) : undefined;
      return { kind: 'LOADED', resolution, invoice, lastOutcome: last?.outcome ?? null, lastSeq: last?.seq ?? 0, signedDps } as const;
    });
    if (loaded.kind !== 'LOADED') return loaded;
    const { resolution, invoice } = loaded;

    if (invoice.status !== 'UNKNOWN') return this.refuse(companyId, resolution.id, invoice.id, 'SERVICE_INVOICE_NOT_UNKNOWN', context);

    if (resolution.outcome === 'NOT_ISSUED') {
      if (blocksNotIssued(loaded.lastOutcome)) return this.refuse(companyId, resolution.id, invoice.id, 'AUTHORIZER_REPORTED_EXISTING', context);
      return this.uow.inCompany(companyId, async (r): Promise<ApplyResult> => {
        if (!(await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'PENDING'))) return this.refuseIn(r, resolution.id, invoice.id, 'SERVICE_INVOICE_NOT_UNKNOWN', context);
        await r.resolutions.decide(resolution.id, 'APPLIED', 'RETRANSMISSION_SCHEDULED', this.now());
        await r.audit.record(context, {
          action: 'service_invoice.resolution_applied',
          subject: { type: 'service_invoice', id: invoice.id },
          details: { resolutionId: resolution.id, outcome: 'NOT_ISSUED', operator: resolution.operator, afterAttempt: loaded.lastSeq },
        });
        await r.jobs.enqueue({
          queue: 'nfse.process',
          payload: { companyId, invoiceId: invoice.id },
          singletonKey: `${invoice.id}:manual:${resolution.id}`,
          correlationId: context.correlationId,
        });
        return { kind: 'APPLIED', outcome: 'NOT_ISSUED' };
      });
    }

    const nfseXml = resolution.nfseXml;
    if (nfseXml === null || sha256(nfseXml) !== resolution.evidenceSha256) return this.refuse(companyId, resolution.id, invoice.id, 'EVIDENCE_HASH_MISMATCH', context);
    // Fora da transação: o XSD leva centenas de ms.
    const verification = await this.verifier.verify(nfseXml, {
      dpsId: invoice.dpsId,
      environment: invoice.environment,
      layoutPackage: invoice.layoutPackage,
      signedDps: loaded.signedDps,
    });
    if (!verification.ok) return this.refuse(companyId, resolution.id, invoice.id, verification.code, context);

    return this.uow.inCompany(companyId, async (r): Promise<ApplyResult> => {
      const changed = await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'AUTHORIZED', {
        authorization: { accessKey: verification.accessKey, nfseXml, authorizedAt: verification.processedAt },
      });
      if (!changed) return this.refuseIn(r, resolution.id, invoice.id, 'SERVICE_INVOICE_NOT_UNKNOWN', context);
      await r.resolutions.decide(resolution.id, 'APPLIED', 'AUTHORIZED', this.now());
      await r.audit.record(context, {
        action: 'service_invoice.resolution_applied',
        subject: { type: 'service_invoice', id: invoice.id },
        details: { resolutionId: resolution.id, outcome: 'AUTHORIZED', operator: resolution.operator, accessKey: verification.accessKey, dpsSignature: verification.dpsSignature },
      });
      await publishStatus(r, invoice, 'AUTHORIZED', context, { resolvedBy: 'MANUAL' });
      return { kind: 'APPLIED', outcome: 'AUTHORIZED' };
    });
  }

  private refuse(companyId: string, resolutionId: string, invoiceId: string, code: string, context: AuditContext): Promise<ApplyResult> {
    return this.uow.inCompany(companyId, (r) => this.refuseIn(r, resolutionId, invoiceId, code, context));
  }

  private async refuseIn(r: NfseWorkerRepositories, resolutionId: string, invoiceId: string, code: string, context: AuditContext): Promise<ApplyResult> {
    if (!(await r.resolutions.decide(resolutionId, 'REFUSED', code, this.now()))) return { kind: 'SKIPPED', reason: 'ALREADY_DECIDED' };
    await r.audit.record(context, {
      action: 'service_invoice.resolution_refused',
      subject: { type: 'service_invoice', id: invoiceId },
      details: { resolutionId, code },
    });
    return { kind: 'REFUSED', code };
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
