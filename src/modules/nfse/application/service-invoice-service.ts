import { clientApplicationOf, type AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, ConflictError, ForbiddenError, InternalError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import type { DpsData } from '../domain/dps.js';
import { buildDpsId } from '../domain/dps-id.js';
import { route, SUPPORTED_CHANNELS, type RoutingTable } from '../domain/routing.js';
import { checkSubstitutionReason, lockedFieldChanges, type SubstitutionReason } from '../domain/substitution.js';
import type { DpsValidator, FiscalEnvironment, NfseApiRepositories, ServiceInvoice, SubstitutionOf } from './ports.js';

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
  /** Contrato v1 (ADR-0033), já validado no formato pela apresentação (L1). */
  readonly dps: DpsData;
}

/** Substituição (ADR-0036): a nota nova sai do MESMO estabelecimento da original (E0042). */
export interface SubstituteServiceInvoice extends Omit<AcceptServiceInvoice, 'establishmentId'> {
  readonly originalId: string;
  readonly reason: SubstitutionReason;
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
    /** Tabela de roteamento vigente (ADR-0028). */
    private readonly routing: RoutingTable,
    /** Sem validador (testes do núcleo), o aceite não pré-valida no XSD. */
    private readonly validator?: DpsValidator,
  ) {}

  async accept(input: AcceptServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    await this.prevalidate(input);
    return this.withIdempotencyRace(input, (r) => this.acceptIn(r, input, context));
  }

  /**
   * Substituição (ADR-0036): aceita uma NFS-e nova com o grupo `subst` apontando para a original.
   * A original continua AUTHORIZED até a substituta ser autorizada; então, na mesma transação, vira
   * SUBSTITUTED. Pedidos sobre a mesma original (substituição e cancelamento) são serializados.
   */
  async substitute(input: SubstituteServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    const reason = checkSubstitutionReason(input.reason);
    if (!reason.ok) {
      throw new ValidationFailedError(
        [{ code: reason.error, field: 'substitution.reasonText', message: 'Com o motivo 99 (Outros), a descrição do motivo é obrigatória (E0078).' }],
        'Motivo da substituição incompleto.',
      );
    }
    await this.prevalidate(input);
    return this.withIdempotencyRace(input, (r) => this.substituteIn(r, input, context));
  }

  /**
   * Pré-validação estrutural fora da transação: o XSD leva centenas de ms e não pode segurar a
   * trava da série. Repetição idempotente de um pedido já aceito passa por aqui de novo, sem efeito.
   */
  private async prevalidate(input: Pick<AcceptServiceInvoice, 'environment' | 'dps'>): Promise<void> {
    if (this.validator === undefined) return;
    const problems = await this.validator.validate(input.environment, input.dps);
    if (problems.length > 0) {
      throw new ValidationFailedError(
        problems.map((message) => ({ code: 'DPS_SCHEMA_INVALID', message })),
        'A DPS não passa no schema oficial (XSD) do ambiente.',
      );
    }
  }

  private async withIdempotencyRace(
    input: Pick<AcceptServiceInvoice, 'companyId' | 'clientApplicationId' | 'idempotencyKey' | 'requestHash'>,
    work: (r: NfseApiRepositories) => Promise<AcceptResult>,
  ): Promise<AcceptResult> {
    try {
      return await this.uow.inCompany(input.companyId, work);
    } catch (error) {
      if (!(error instanceof ConflictError && error.code === IDEMPOTENCY_RACE)) throw error;
      const winner = await this.uow.inCompany(input.companyId, (r) => r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey));
      if (winner === undefined) throw new InternalError('IDEMPOTENCY_RACE_WITHOUT_WINNER');
      return replay(winner, input);
    }
  }

  /**
   * Documento de outra aplicação cliente ou de outro ambiente é tratado como inexistente: uma
   * credencial `test` não enxerga notas de produção, e vice-versa.
   */
  async get(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<ServiceInvoice> {
    const found = await this.uow.inCompany(companyId, (r) => r.invoices.findById(id));
    if (found?.clientApplicationId !== clientApplicationId || found.environment !== environment) throw notFound();
    return found;
  }

  private async acceptIn(r: NfseApiRepositories, input: AcceptServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    const existing = await r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey);
    if (existing !== undefined) return replay(existing, input);
    return this.create(r, input, null, context);
  }

  private async substituteIn(r: NfseApiRepositories, input: SubstituteServiceInvoice, context: AuditContext): Promise<AcceptResult> {
    // Antes de qualquer leitura: o cancelamento da mesma nota espera esta transação terminar.
    await r.invoices.lockForEvents(input.originalId);
    const existing = await r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey);
    if (existing !== undefined) return replay(existing, input);

    const original = await r.invoices.findById(input.originalId);
    if (original?.clientApplicationId !== input.clientApplicationId || original.environment !== input.environment) throw notFound();
    if (original.status !== 'AUTHORIZED') {
      throw new BusinessRuleError('SERVICE_INVOICE_NOT_AUTHORIZED', `Só NFS-e autorizada pode ser substituída (a nota está em ${original.status}).`);
    }
    // E0065: a substituta sai pelo mesmo ambiente gerador; só o canal nacional é suportado.
    if (original.routingChannel !== 'NATIONAL_SEFIN' || original.nfseAccessKey === null) {
      throw new BusinessRuleError('NFSE_CHANNEL_NOT_AVAILABLE', 'A substituição desta nota não está disponível pelo canal em que ela foi emitida.');
    }
    const cancellation = await r.cancellations.findActive(original.id);
    if (cancellation !== undefined) {
      throw new ConflictError('CANCELLATION_IN_PROGRESS', `A NFS-e tem pedido de cancelamento em andamento (${cancellation.id}, ${cancellation.state}).`);
    }
    const active = await r.invoices.findActiveSubstitute(original.id);
    if (active !== undefined) {
      throw new ConflictError('SUBSTITUTION_IN_PROGRESS', `Já existe nota substituta para esta NFS-e (${active.id}, ${active.status}). Não emita outra.`);
    }
    const locked = lockedFieldChanges(original.payload as unknown as DpsData, input.dps, input.environment);
    if (locked.length > 0) {
      throw new BusinessRuleError(
        'SUBSTITUTION_LOCKED_FIELDS',
        'A substituta não pode mudar estes campos da nota original (regras de substituição do Anexo I, conforme a opção pelo Simples Nacional).',
        locked.map((change) => ({ code: change.rule, field: change.field, message: 'Este campo não pode mudar na substituição.' })),
      );
    }
    const substitution: SubstitutionOf = {
      invoiceId: original.id,
      accessKey: original.nfseAccessKey,
      reasonCode: input.reason.code,
      reasonText: input.reason.text,
    };
    return this.create(r, { ...input, establishmentId: original.establishmentId }, substitution, context);
  }

  private async create(r: NfseApiRepositories, input: AcceptServiceInvoice, substitution: SubstitutionOf | null, context: AuditContext): Promise<AcceptResult> {
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

    // Canal pela competência (ADR-0028), antes de numerar: sem canal, nada é consumido.
    const channel = this.channelFor(establishment.municipalityCode, input.dps);

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
      payload: input.dps as unknown as Readonly<Record<string, unknown>>,
      routingChannel: channel,
      routingTableVersion: this.routing.version,
      substitution,
    });
    if (substitution !== null) {
      await r.audit.record(context, {
        action: 'service_invoice.substitution_requested',
        subject: { type: 'service_invoice', id: substitution.invoiceId },
        details: { substituteId: invoice.id, reasonCode: substitution.reasonCode },
      });
    }
    await r.audit.record(context, {
      action: 'service_invoice.accepted',
      subject: { type: 'service_invoice', id: invoice.id },
      details: {
        establishmentId: invoice.establishmentId,
        environment: invoice.environment,
        series: invoice.series,
        number: invoice.number,
        dpsId: invoice.dpsId,
        routingChannel: channel,
        routingTableVersion: this.routing.version,
        clientApplicationId: clientApplicationOf(context) ?? null,
        substitutesInvoiceId: substitution?.invoiceId ?? null,
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

  /**
   * Aplica a tabela de roteamento. Recusa (422) com a explicação em `issues`: sem linha, linha
   * "a confirmar", linhas conflitantes ou canal ainda sem adapter. Nunca um canal padrão.
   */
  private channelFor(municipalityCode: string, dps: DpsData): string {
    const decision = route(this.routing, {
      municipalityCode,
      simplesNacionalOption: dps.provider.simplesNacionalOption,
      simplesNacionalRegime: dps.provider.simplesNacionalRegime,
      competenceDate: dps.competenceDate,
    });
    const refuse = (code: string, message: string, field?: string): never => {
      throw new BusinessRuleError(CHANNEL_NOT_AVAILABLE, 'Não há canal de emissão disponível para esta NFS-e.', [
        { code, message, ...(field === undefined ? {} : { field }) },
      ]);
    };
    switch (decision.kind) {
      case 'ROUTED':
        if (!SUPPORTED_CHANNELS.includes(decision.channel)) {
          return refuse(
            'ROUTE_CHANNEL_NOT_SUPPORTED',
            `O canal desta nota é ${decision.channel} (por exemplo, competência anterior a 11/2026 ou prestador não optante em Teresina), ainda não suportado. Emita pelo emissor municipal.`,
          );
        }
        return decision.channel;
      case 'TO_CONFIRM':
        return refuse(
          'ROUTE_PENDING_CONFIRMATION',
          'O canal para este enquadramento ainda depende de confirmação oficial (ADR-0028, linha "a confirmar"). Confirme com o contador.',
          'provider.simplesNacionalRegime',
        );
      case 'AMBIGUOUS':
        return refuse('ROUTE_AMBIGUOUS', `A tabela de roteamento tem regras conflitantes para este caso (${decision.rows.join(', ')}). Nenhum canal é escolhido sem confirmação.`);
      case 'NO_ROUTE':
        return decision.regimeWouldMatter
          ? refuse('ROUTE_REGIME_REQUIRED', 'Informe o regime de apuração do Simples (simplesNacionalRegime): o canal depende dele.', 'provider.simplesNacionalRegime')
          : refuse('ROUTE_NOT_FOUND', 'Nenhuma regra de roteamento cobre este município, enquadramento e competência.');
    }
  }
}

const CHANNEL_NOT_AVAILABLE = 'NFSE_CHANNEL_NOT_AVAILABLE';

function replay(existing: ServiceInvoice, input: Pick<AcceptServiceInvoice, 'requestHash'>): AcceptResult {
  if (existing.requestHash !== input.requestHash) {
    throw new BusinessRuleError('IDEMPOTENCY_KEY_REUSED', 'Esta Idempotency-Key já foi usada com outro conteúdo. Use uma chave nova para um documento novo.');
  }
  return { invoice: existing, replayed: true };
}

const notFound = () => new NotFoundError('SERVICE_INVOICE_NOT_FOUND', 'NFS-e não encontrada.');
