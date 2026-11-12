import { clientApplicationOf, type AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, ConflictError, ForbiddenError, InternalError, NotFoundError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { buildDpsId } from '../domain/dps-id.js';
import type { FiscalEnvironment, NfseApiRepositories, ServiceInvoice } from './ports.js';

export interface AcceptServiceInvoice {
  readonly companyId: string;
  readonly clientApplicationId: string;
  /** Vem da credencial (ADR-0026 item 3): `test` → homologação, `live` → produção. */
  readonly environment: FiscalEnvironment;
  readonly establishmentId: string;
  /** Opcional quando o estabelecimento tem uma única série ativa no ambiente. */
  readonly seriesId?: string | undefined;
  readonly idempotencyKey: string;
  /** SHA-256 do pedido normalizado (ADR-0007). */
  readonly requestHash: string;
  readonly externalReference: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AcceptResult {
  readonly invoice: ServiceInvoice;
  /** Repetição da mesma requisição: devolve o documento já aceito, sem criar outro. */
  readonly replayed: boolean;
}

/** Código interno da corrida perdida na chave de idempotência (constraint → releitura). */
export const IDEMPOTENCY_RACE = 'SERVICE_INVOICE_IDEMPOTENCY_RACE';

/**
 * Aceite de NFS-e na API (ADR-0032 item 3). Numa transação: idempotência, série do ambiente,
 * trava de produção, número (ADR-0008), Id da DPS, PENDING, auditoria e job `nfse.process`.
 *
 * Repetir a requisição nunca gera outro documento (ADR-0007): a chave é conferida antes e,
 * numa corrida, a restrição UNIQUE decide e o perdedor relê o documento vencedor.
 */
export class ServiceInvoiceService {
  constructor(
    private readonly uow: UnitOfWork<NfseApiRepositories>,
    private readonly newId: IdGenerator,
  ) {}

  async accept(input: AcceptServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    try {
      return await this.uow.inCompany(input.companyId, (r) => this.acceptIn(r, input, context));
    } catch (error) {
      if (!(error instanceof ConflictError && error.code === IDEMPOTENCY_RACE)) throw error;
      const winner = await this.uow.inCompany(input.companyId, (r) => r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey));
      if (winner === undefined) throw new InternalError('IDEMPOTENCY_RACE_WITHOUT_WINNER');
      return replay(winner, input);
    }
  }

  async get(companyId: string, clientApplicationId: string, id: string): Promise<ServiceInvoice> {
    const found = await this.uow.inCompany(companyId, (r) => r.invoices.findById(id));
    // Documento de outra aplicação cliente da mesma empresa é tratado como inexistente.
    if (found?.clientApplicationId !== clientApplicationId) throw notFound();
    return found;
  }

  private async acceptIn(r: NfseApiRepositories, input: AcceptServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    const existing = await r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey);
    if (existing !== undefined) return replay(existing, input);

    if (input.externalReference !== null) {
      const occupied = await r.invoices.findActiveByExternalReference(input.clientApplicationId, input.externalReference);
      if (occupied !== undefined) {
        throw occupied.status === 'AUTHORIZED'
          ? new ConflictError('DOCUMENT_ALREADY_AUTHORIZED', `Já existe NFS-e autorizada com esta referência externa (${occupied.id}).`)
          : new ConflictError('DOCUMENT_IN_PROGRESS', `Já existe NFS-e em andamento com esta referência externa (${occupied.id}). Não reemita.`);
      }
    }

    const establishment = await r.establishments.find(input.establishmentId);
    if (establishment === undefined) throw new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.');
    if (establishment.status !== 'ACTIVE') throw new BusinessRuleError('ESTABLISHMENT_INACTIVE', 'O estabelecimento está inativo.');

    if (input.environment === 'PRODUCTION' && !(await r.production.isEnabled(establishment.id))) {
      throw new ForbiddenError('PRODUCTION_NOT_ENABLED', 'A NFS-e não está habilitada para produção neste estabelecimento (PROD-001).');
    }

    const candidates = await r.series.activeSeries(establishment.id, input.environment);
    const series =
      input.seriesId === undefined
        ? candidates.length === 1
          ? candidates[0]
          : undefined
        : candidates.find((s) => s.id === input.seriesId);
    if (series === undefined) {
      if (input.seriesId !== undefined || candidates.length === 0) {
        throw new BusinessRuleError('NFSE_SERIES_NOT_AVAILABLE', 'Não há série de DPS ativa (ou a informada não é ativa) para o estabelecimento neste ambiente.');
      }
      throw new BusinessRuleError('NFSE_SERIES_REQUIRED', 'O estabelecimento tem mais de uma série de DPS ativa neste ambiente: informe a série.');
    }

    const number = await r.series.allocate(series.id);
    const dpsId = buildDpsId({
      municipalityCode: establishment.municipalityCode,
      registration: { kind: 'CNPJ', value: establishment.cnpj },
      series: series.series,
      number,
    });
    if (!dpsId.ok) throw new InternalError(`DPS_ID_${dpsId.error}`);

    const invoice = await r.invoices.insert({
      id: this.newId(),
      companyId: input.companyId,
      establishmentId: establishment.id,
      clientApplicationId: input.clientApplicationId,
      environment: input.environment,
      seriesId: series.id,
      series: series.series,
      number,
      dpsId: dpsId.value,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      externalReference: input.externalReference,
      payload: input.payload,
    });
    await r.audit.record(context, {
      action: 'service_invoice.accepted',
      subject: { type: 'service_invoice', id: invoice.id },
      details: {
        establishmentId: invoice.establishmentId,
        environment: invoice.environment,
        series: invoice.series,
        number: invoice.number,
        dpsId: invoice.dpsId,
        clientApplicationId: clientApplicationOf(context) ?? null,
      },
    });
    await r.jobs.enqueue({
      queue: 'nfse.process',
      payload: { companyId: invoice.companyId, invoiceId: invoice.id },
      singletonKey: invoice.id,
      correlationId: context.correlationId,
    });
    return { invoice, replayed: false };
  }
}

function replay(existing: ServiceInvoice, input: AcceptServiceInvoice): AcceptResult {
  if (existing.requestHash !== input.requestHash) {
    throw new BusinessRuleError('IDEMPOTENCY_KEY_REUSED', 'Esta Idempotency-Key já foi usada com outro conteúdo. Use uma chave nova para um documento novo.');
  }
  return { invoice: existing, replayed: true };
}

const notFound = () => new NotFoundError('SERVICE_INVOICE_NOT_FOUND', 'NFS-e não encontrada.');
