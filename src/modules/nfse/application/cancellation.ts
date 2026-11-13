import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, ConflictError, InternalError, NotFoundError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { retryDelaySeconds } from '../../../shared/domain/backoff.js';
import { CANCELLATION_EVENT_TYPE, type CancellationReasonCode, type CancellationState } from '../domain/cancellation.js';
import { afterLookup, DEFAULT_RECONCILIATION_POLICY, nextStep, type LookupResult, type ReconciliationPolicy } from '../domain/reconciliation.js';
import type {
  CancellationPreparer,
  CredentialAccess,
  EventLookupOutcome,
  EventOutcome,
  FiscalEnvironment,
  IssuerCredential,
  NfseApiRepositories,
  NfseGateway,
  NfseWorkerRepositories,
  ServiceInvoice,
  ServiceInvoiceCancellation,
} from './ports.js';
import { publishStatus } from './submission-processor.js';

/** Código interno da corrida no índice de pedido ativo (constraint → releitura). */
export const CANCELLATION_RACE = 'SERVICE_INVOICE_CANCELLATION_RACE';

export interface RequestCancellation {
  readonly companyId: string;
  readonly clientApplicationId: string;
  readonly environment: FiscalEnvironment;
  readonly invoiceId: string;
  readonly reasonCode: CancellationReasonCode;
  readonly reasonText: string;
}

export interface CancellationRequestResult {
  readonly cancellation: ServiceInvoiceCancellation;
  readonly replayed: boolean;
}

/**
 * Pedido de cancelamento pela API (ADR-0035 itens 1 e 2). Numa transação: a nota tem de ser
 * da aplicação e do ambiente da credencial, estar AUTHORIZED e no canal NATIONAL_SEFIN. Um
 * pedido ativo por nota: o mesmo corpo devolve o mesmo pedido; outro corpo é conflito.
 */
export class CancellationService {
  constructor(
    private readonly uow: UnitOfWork<NfseApiRepositories>,
    private readonly newId: IdGenerator,
  ) {}

  async request(input: RequestCancellation, context: AuditContext): Promise<CancellationRequestResult> {
    const requestHash = sha256(JSON.stringify({ environment: input.environment, reasonCode: input.reasonCode, reasonText: input.reasonText }));
    try {
      return await this.uow.inCompany(input.companyId, (r) => this.requestIn(r, input, requestHash, context));
    } catch (error) {
      if (!(error instanceof ConflictError && error.code === CANCELLATION_RACE)) throw error;
      const winner = await this.uow.inCompany(input.companyId, (r) => r.cancellations.findActive(input.invoiceId));
      if (winner === undefined) throw new InternalError('CANCELLATION_RACE_WITHOUT_WINNER');
      return replay(winner, requestHash);
    }
  }

  async get(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, invoiceId: string): Promise<ServiceInvoiceCancellation> {
    return this.uow.inCompany(companyId, async (r) => {
      await visibleInvoice(r, clientApplicationId, environment, invoiceId);
      const found = await r.cancellations.findLatest(invoiceId);
      if (found === undefined) throw new NotFoundError('CANCELLATION_NOT_FOUND', 'Não há pedido de cancelamento para esta NFS-e.');
      return found;
    });
  }

  private async requestIn(r: NfseApiRepositories, input: RequestCancellation, requestHash: string, context: AuditContext): Promise<CancellationRequestResult> {
    // Serializa com a substituição da mesma nota (ADR-0036 item 3).
    await r.invoices.lockForEvents(input.invoiceId);
    const invoice = await visibleInvoice(r, input.clientApplicationId, input.environment, input.invoiceId);
    const active = await r.cancellations.findActive(invoice.id);
    if (active !== undefined) return replay(active, requestHash);
    const substitute = await r.invoices.findActiveSubstitute(invoice.id);
    if (substitute !== undefined && invoice.status === 'AUTHORIZED') {
      throw new ConflictError('SUBSTITUTION_IN_PROGRESS', `A NFS-e tem substituição em andamento (${substitute.id}, ${substitute.status}): não pode ser cancelada.`);
    }
    if (invoice.status !== 'AUTHORIZED') {
      throw new BusinessRuleError('SERVICE_INVOICE_NOT_AUTHORIZED', `Só NFS-e autorizada pode ser cancelada (a nota está em ${invoice.status}).`);
    }
    if (invoice.routingChannel !== 'NATIONAL_SEFIN') {
      throw new BusinessRuleError('NFSE_CHANNEL_NOT_AVAILABLE', 'O cancelamento desta nota não está disponível pelo canal em que ela foi emitida.');
    }
    const cancellation = await r.cancellations.insert({
      id: this.newId(),
      companyId: input.companyId,
      invoiceId: invoice.id,
      clientApplicationId: input.clientApplicationId,
      requestHash,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
    });
    await r.audit.record(context, {
      action: 'service_invoice.cancellation_requested',
      subject: { type: 'service_invoice', id: invoice.id },
      details: { cancellationId: cancellation.id, reasonCode: input.reasonCode },
    });
    await r.jobs.enqueue({
      queue: 'nfse.cancel',
      payload: { companyId: input.companyId, cancellationId: cancellation.id },
      singletonKey: cancellation.id,
      correlationId: context.correlationId,
    });
    return { cancellation, replayed: false };
  }
}

async function visibleInvoice(r: NfseApiRepositories, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<ServiceInvoice> {
  const invoice = await r.invoices.findById(id);
  // Nota de outra aplicação ou de outro ambiente é tratada como inexistente.
  if (invoice?.clientApplicationId !== clientApplicationId || invoice.environment !== environment) {
    throw new NotFoundError('SERVICE_INVOICE_NOT_FOUND', 'NFS-e não encontrada.');
  }
  return invoice;
}

function replay(existing: ServiceInvoiceCancellation, requestHash: string): CancellationRequestResult {
  if (existing.requestHash !== requestHash) {
    throw new ConflictError('CANCELLATION_ALREADY_REQUESTED', `Já há um pedido de cancelamento para esta NFS-e (${existing.state}) com outro motivo.`);
  }
  return { cancellation: existing, replayed: true };
}

// ================================================================== worker-fiscal

export interface CancellationOptions {
  readonly leaseMs: number;
  readonly reconciliation: ReconciliationPolicy;
  readonly notSentBackoff: { readonly baseSeconds: number; readonly maxSeconds: number; readonly jitter: number };
}

export const DEFAULT_CANCELLATION_OPTIONS: CancellationOptions = {
  leaseMs: 120_000,
  reconciliation: DEFAULT_RECONCILIATION_POLICY,
  notSentBackoff: { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 },
};

export type CancellationProcessResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'LEASED' | 'NOT_PENDING' }
  | { readonly kind: 'FAILED'; readonly code: string }
  | { readonly kind: 'DEFERRED'; readonly code: string }
  | { readonly kind: 'TRANSMITTED'; readonly outcome: EventOutcome['kind'] };

/**
 * Envio do cancelamento com write-ahead no próprio registro (ADR-0035 item 3):
 *
 *   TX1  PENDING → PROCESSING (concessão; zera a marca de envio)
 *   ---  certificado + pedido assinado (uma vez; depois, os mesmos bytes)
 *   TX2  sending_at  ← commit ANTES da rede
 *   ---  gateway.registerEvent
 *   TX3  resultado
 *
 * Queda: PROCESSING com a concessão vencida e `sending_at` gravado → UNKNOWN; sem → PENDING.
 */
export class CancellationProcessor {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly credentials: CredentialAccess,
    private readonly preparer: CancellationPreparer,
    private readonly gateway: NfseGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly options: CancellationOptions = DEFAULT_CANCELLATION_OPTIONS,
  ) {}

  async process(companyId: string, cancellationId: string, context: AuditContext): Promise<CancellationProcessResult> {
    const recovered = await this.recoverIfStuck(companyId, cancellationId, context);
    if (recovered !== undefined) return recovered;

    const claimed = await this.uow.inCompany(companyId, async (r) => {
      const cancellation = await r.cancellations.find(cancellationId);
      if (cancellation === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (cancellation.state !== 'PENDING') return { kind: 'SKIPPED', reason: 'NOT_PENDING' } as const;
      const invoice = await r.invoices.findById(cancellation.invoiceId);
      if (invoice === undefined) throw new Error('cancelamento sem documento');
      const leaseUntil = new Date(this.now().getTime() + this.options.leaseMs);
      if (!(await r.cancellations.changeState(cancellation.id, 'PENDING', 'PROCESSING', { leaseUntil, clearSending: true }))) {
        return { kind: 'SKIPPED', reason: 'NOT_PENDING' } as const;
      }
      return { kind: 'CLAIMED', cancellation, invoice } as const;
    });
    if (claimed.kind !== 'CLAIMED') return claimed;
    const { cancellation, invoice } = claimed;

    try {
      return await this.credentials.withCredential(companyId, invoice.establishmentId, (credential) => this.transmit(companyId, cancellation, invoice, credential, context));
    } catch (error) {
      if (error instanceof BusinessRuleError && error.code.startsWith('CERTIFICATE_')) {
        return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, cancellation, invoice, 'PROCESSING', error.code, context));
      }
      throw error;
    }
  }

  private async transmit(
    companyId: string,
    cancellation: ServiceInvoiceCancellation,
    invoice: ServiceInvoice,
    credential: IssuerCredential,
    context: AuditContext,
  ): Promise<CancellationProcessResult> {
    let signed = cancellation.signedSha256 === null ? undefined : await this.uow.inCompany(companyId, (r) => r.cancellations.signedXml(cancellation.id));
    if (signed === undefined) {
      const prepared = await this.preparer.prepare(cancellation, invoice, credential);
      if (!prepared.ok) return this.uow.inCompany(companyId, (r) => this.failOrDefer(r, cancellation, invoice, 'PROCESSING', prepared.code, context));
      signed = prepared.signedXml;
      const xml = signed;
      await this.uow.inCompany(companyId, (r) => r.cancellations.storeSigned(cancellation.id, { xml, sha256: sha256(xml), layoutPackage: prepared.layoutPackage }));
    } else if (cancellation.signedSha256 !== sha256(signed)) {
      throw new Error('SIGNED_EVENT_HASH_MISMATCH');
    }
    const accessKey = invoice.nfseAccessKey;
    if (accessKey === null) throw new Error('nota autorizada sem chave');

    const sendingAt = this.now();
    await this.uow.inCompany(companyId, (r) => r.cancellations.markSending(cancellation.id, sendingAt));

    let outcome: EventOutcome;
    try {
      outcome = await this.gateway.registerEvent(accessKey, signed, { environment: invoice.environment, credential });
    } catch {
      outcome = { kind: 'UNKNOWN', errorCode: 'GATEWAY_EXCEPTION' };
    }

    await this.uow.inCompany(companyId, async (r) => {
      const at = this.now();
      switch (outcome.kind) {
        case 'REGISTERED':
          await registered(r, cancellation, invoice, 'PROCESSING', outcome.eventXml, at, context, { leaseUntil: null, outcomeCode: null });
          return;
        case 'REJECTED':
          await settle(r, cancellation, invoice, 'PROCESSING', 'REJECTED', context, { leaseUntil: null, outcomeCode: outcome.code, rejectionMessage: outcome.message });
          return;
        case 'NOT_SENT': {
          await r.cancellations.changeState(cancellation.id, 'PROCESSING', 'PENDING', { leaseUntil: null, clearSending: true, outcomeCode: outcome.errorCode });
          const fresh = await r.cancellations.find(cancellation.id);
          const delay = retryDelaySeconds(fresh?.attempts ?? 1, this.options.notSentBackoff);
          await r.jobs.enqueue({
            queue: 'nfse.cancel',
            payload: { companyId, cancellationId: cancellation.id },
            singletonKey: `${cancellation.id}:resend:${fresh?.attempts ?? 1}`,
            runAt: new Date(at.getTime() + delay * 1000),
            correlationId: context.correlationId,
          });
          return;
        }
        case 'UNKNOWN':
        case 'ALREADY_EXISTS': {
          await settle(r, cancellation, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null, outcomeCode: outcome.kind === 'UNKNOWN' ? outcome.errorCode : 'ALREADY_EXISTS' });
          const fresh = await r.cancellations.find(cancellation.id);
          const runAt = outcome.kind === 'ALREADY_EXISTS' ? at : new Date(sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs);
          await scheduleLookup(r, companyId, cancellation.id, fresh?.attempts ?? 1, 0, runAt, context);
          return;
        }
      }
    });
    return { kind: 'TRANSMITTED', outcome: outcome.kind };
  }

  private recoverIfStuck(companyId: string, cancellationId: string, context: AuditContext): Promise<CancellationProcessResult | undefined> {
    return this.uow.inCompany(companyId, async (r) => {
      const cancellation = await r.cancellations.find(cancellationId);
      if (cancellation === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (cancellation.state !== 'PROCESSING') return undefined;
      if (cancellation.leaseUntil !== null && cancellation.leaseUntil.getTime() > this.now().getTime()) return { kind: 'SKIPPED', reason: 'LEASED' } as const;
      const invoice = await r.invoices.findById(cancellation.invoiceId);
      if (invoice === undefined) throw new Error('cancelamento sem documento');
      if (cancellation.sendingAt !== null) {
        // Pode ter saído: só a consulta decide.
        await settle(r, cancellation, invoice, 'PROCESSING', 'UNKNOWN', context, { leaseUntil: null, outcomeCode: 'RECOVERED_UNKNOWN' });
        await scheduleLookup(r, companyId, cancellation.id, cancellation.attempts, 0, new Date(cancellation.sendingAt.getTime() + this.options.reconciliation.minWaitAfterSendingMs), context);
        return { kind: 'TRANSMITTED', outcome: 'UNKNOWN' } as const;
      }
      await r.cancellations.changeState(cancellation.id, 'PROCESSING', 'PENDING', { leaseUntil: null });
      return undefined;
    });
  }

  /** FAILED só se nunca houve envio; senão, volta a PENDING e o job tenta de novo. */
  private async failOrDefer(
    r: NfseWorkerRepositories,
    cancellation: ServiceInvoiceCancellation,
    invoice: ServiceInvoice,
    from: 'PROCESSING',
    code: string,
    context: AuditContext,
  ): Promise<CancellationProcessResult> {
    if (cancellation.attempts > 0) {
      await r.cancellations.changeState(cancellation.id, from, 'PENDING', { leaseUntil: null });
      return { kind: 'DEFERRED', code };
    }
    await settle(r, cancellation, invoice, from, 'FAILED', context, { leaseUntil: null, failureCode: code });
    return { kind: 'FAILED', code };
  }
}

export type CancellationReconcileResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'NOT_UNKNOWN' }
  | { readonly kind: 'WAITING'; readonly until: Date }
  | { readonly kind: 'REGISTERED' }
  | { readonly kind: 'RETRANSMISSION_SCHEDULED' }
  | { readonly kind: 'CONSULT_AGAIN'; readonly at: Date; readonly lookup: EventLookupOutcome['kind'] };

/**
 * Reconciliação do cancelamento em UNKNOWN: consulta o evento na nota, com a MESMA política da
 * emissão (ADR-0029). Encontrado → REGISTERED e nota CANCELLED; inexistência provada duas vezes →
 * retransmite os mesmos bytes; erro → backoff, para sempre.
 */
export class CancellationReconciler {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly credentials: CredentialAccess,
    private readonly gateway: NfseGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
  ) {}

  async reconcile(companyId: string, cancellationId: string, context: AuditContext): Promise<CancellationReconcileResult> {
    const loaded = await this.uow.inCompany(companyId, async (r) => {
      const cancellation = await r.cancellations.find(cancellationId);
      if (cancellation === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (cancellation.state !== 'UNKNOWN') return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' } as const;
      const invoice = await r.invoices.findById(cancellation.invoiceId);
      if (invoice?.nfseAccessKey == null) throw new Error('cancelamento sem nota autorizada');
      return { kind: 'LOADED', cancellation, invoice, accessKey: invoice.nfseAccessKey } as const;
    });
    if (loaded.kind !== 'LOADED') return loaded;
    const { cancellation, invoice, accessKey } = loaded;

    const state = {
      sendingAt: cancellation.sendingAt ?? cancellation.updatedAt,
      firstNotFoundAt: cancellation.firstNotFoundAt,
      consecutiveLookupErrors: cancellation.consecutiveLookupErrors,
    };
    const step = cancellation.outcomeCode === 'ALREADY_EXISTS' ? ({ kind: 'LOOKUP' } as const) : nextStep(state, this.now(), this.policy);
    if (step.kind === 'WAIT_UNTIL') {
      await this.uow.inCompany(companyId, (r) => scheduleLookup(r, companyId, cancellation.id, cancellation.attempts, `${cancellation.lookups}:w${step.at.getTime()}`, step.at, context));
      return { kind: 'WAITING', until: step.at };
    }

    let lookup: EventLookupOutcome;
    try {
      lookup = await this.credentials.withCredential(companyId, invoice.establishmentId, (credential) =>
        this.gateway.findEvent(accessKey, CANCELLATION_EVENT_TYPE, { environment: invoice.environment, credential }),
      );
    } catch (error) {
      lookup = { kind: 'ERROR', errorCode: error instanceof BusinessRuleError ? error.code : 'LOOKUP_EXCEPTION' };
    }
    const at = this.now();
    const result: LookupResult = lookup.kind === 'FOUND' ? { kind: 'FOUND' } : lookup.kind === 'NOT_FOUND' ? { kind: 'NOT_FOUND' } : { kind: 'ERROR' };
    const decision = afterLookup(state, result, at, this.policy);

    return this.uow.inCompany(companyId, async (r): Promise<CancellationReconcileResult> => {
      switch (decision.kind) {
        case 'AUTHORIZED': {
          if (lookup.kind !== 'FOUND') throw new Error('inconsistência na decisão da reconciliação');
          await r.cancellations.recordLookup(cancellation.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          if (!(await registered(r, cancellation, invoice, 'UNKNOWN', lookup.eventXml, at, context, {}))) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          return { kind: 'REGISTERED' };
        }
        case 'RETRANSMIT': {
          await r.cancellations.recordLookup(cancellation.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          if (!(await r.cancellations.changeState(cancellation.id, 'UNKNOWN', 'PENDING', { resetLookups: true }))) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          await r.audit.record(context, {
            action: 'service_invoice.cancellation_retransmission_scheduled',
            subject: { type: 'service_invoice', id: invoice.id },
            details: { cancellationId: cancellation.id, afterAttempt: cancellation.attempts },
          });
          await r.jobs.enqueue({
            queue: 'nfse.cancel',
            payload: { companyId, cancellationId: cancellation.id },
            singletonKey: `${cancellation.id}:retransmit:${cancellation.attempts}`,
            correlationId: context.correlationId,
          });
          return { kind: 'RETRANSMISSION_SCHEDULED' };
        }
        case 'CONSULT_AGAIN_AT':
          await r.cancellations.recordLookup(cancellation.id, decision.state);
          await scheduleLookup(r, companyId, cancellation.id, cancellation.attempts, cancellation.lookups + 1, decision.at, context);
          return { kind: 'CONSULT_AGAIN', at: decision.at, lookup: lookup.kind };
      }
    });
  }
}

// ------------------------------------------------------------------ comuns

const AUDIT_BY_STATE = {
  REJECTED: 'service_invoice.cancellation_rejected',
  FAILED: 'service_invoice.cancellation_failed',
  UNKNOWN: 'service_invoice.cancellation_unknown',
} as const;

/** Muda o estado do cancelamento (CAS), audita e publica `service_invoice.cancellation_changed`. */
async function settle(
  r: NfseWorkerRepositories,
  cancellation: ServiceInvoiceCancellation,
  invoice: ServiceInvoice,
  from: CancellationState,
  to: 'REJECTED' | 'FAILED' | 'UNKNOWN',
  context: AuditContext,
  change: Parameters<NfseWorkerRepositories['cancellations']['changeState']>[3],
): Promise<void> {
  if (!(await r.cancellations.changeState(cancellation.id, from, to, change))) throw new Error('SERVICE_INVOICE_CANCELLATION_CONCURRENT_CHANGE');
  const extra = {
    ...(to === 'REJECTED' && change?.outcomeCode != null ? { rejectionCode: change.outcomeCode } : {}),
    ...(change?.failureCode === undefined ? {} : { failureCode: change.failureCode }),
  };
  await r.audit.record(context, { action: AUDIT_BY_STATE[to], subject: { type: 'service_invoice', id: invoice.id }, details: { cancellationId: cancellation.id, ...extra } });
  await publishCancellation(r, cancellation, invoice, to, context, extra);
}

/** Evento registrado: cancelamento REGISTERED e nota AUTHORIZED → CANCELLED na mesma transação. */
async function registered(
  r: NfseWorkerRepositories,
  cancellation: ServiceInvoiceCancellation,
  invoice: ServiceInvoice,
  from: 'PROCESSING' | 'UNKNOWN',
  eventXml: string,
  at: Date,
  context: AuditContext,
  change: Parameters<NfseWorkerRepositories['cancellations']['changeState']>[3],
): Promise<boolean> {
  if (!(await r.cancellations.changeState(cancellation.id, from, 'REGISTERED', { ...change, eventXml, registeredAt: at }))) return false;
  if (!(await r.invoices.changeStatus(invoice.id, 'AUTHORIZED', 'CANCELLED'))) throw new Error('SERVICE_INVOICE_NOT_AUTHORIZED_ON_CANCEL');
  await publishCancellation(r, cancellation, invoice, 'REGISTERED', context, {});
  await publishStatus(r, invoice, 'CANCELLED', context, { cancellationId: cancellation.id });
  return true;
}

async function publishCancellation(
  r: Pick<NfseWorkerRepositories, 'events'>,
  cancellation: ServiceInvoiceCancellation,
  invoice: ServiceInvoice,
  state: CancellationState,
  context: AuditContext,
  extra: Readonly<Record<string, string>>,
): Promise<void> {
  await r.events.publish({
    type: 'service_invoice.cancellation_changed',
    subject: { type: 'service_invoice', id: invoice.id },
    data: {
      serviceInvoiceId: invoice.id,
      cancellationId: cancellation.id,
      establishmentId: invoice.establishmentId,
      externalReference: invoice.externalReference,
      environment: invoice.environment,
      status: state,
      ...extra,
    },
    correlationId: context.correlationId,
  });
}

async function scheduleLookup(r: NfseWorkerRepositories, companyId: string, cancellationId: string, attempt: number, lookup: number | string, runAt: Date, context: AuditContext): Promise<void> {
  await r.jobs.enqueue({
    queue: 'nfse.cancel-reconcile',
    payload: { companyId, cancellationId },
    singletonKey: `${cancellationId}:lookup:${attempt}:${lookup}`,
    runAt,
    correlationId: context.correlationId,
  });
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
