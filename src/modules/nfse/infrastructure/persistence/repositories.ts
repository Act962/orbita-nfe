import { and, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import { ConflictError, NotFoundError } from '../../../../shared/application/errors.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../../shared/application/outbox.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type {
  AttemptOutcome,
  AttemptRepository,
  EstablishmentReader,
  FiscalEnvironment,
  NfseApiRepositories,
  NfseWorkerRepositories,
  ProductionGate,
  SeriesAllocator,
  ServiceInvoice,
  ServiceInvoiceRepository,
  ServiceInvoiceWorkerRepository,
  TransmissionAttempt,
} from '../../application/ports.js';
import { IDEMPOTENCY_RACE } from '../../application/service-invoice-service.js';
import type { AttemptState, ServiceInvoiceStatus } from '../../domain/service-invoice.js';
import { serviceInvoiceAttempts, serviceInvoices } from './schema.js';

export const NFSE_CONSTRAINTS: ConstraintErrorMap = {
  // Corrida na mesma Idempotency-Key: o serviço relê o vencedor numa transação nova.
  uq_service_invoices_idempotency: () => new ConflictError(IDEMPOTENCY_RACE, 'Requisição repetida em paralelo.'),
  uq_service_invoices_external_reference: () =>
    new ConflictError('DOCUMENT_IN_PROGRESS', 'Já existe NFS-e em andamento com esta referência externa. Não reemita.'),
  fk_service_invoices_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
};

type InvoiceRow = typeof serviceInvoices.$inferSelect;
type AttemptRow = typeof serviceInvoiceAttempts.$inferSelect;

const toInvoice = (row: InvoiceRow): ServiceInvoice => ({
  id: row.id,
  companyId: row.companyId,
  establishmentId: row.establishmentId,
  clientApplicationId: row.clientApplicationId,
  environment: row.environment as FiscalEnvironment,
  seriesId: row.seriesId,
  series: row.series,
  number: row.number,
  dpsId: row.dpsId,
  idempotencyKey: row.idempotencyKey,
  requestHash: row.requestHash,
  externalReference: row.externalReference,
  payload: row.payload as Record<string, unknown>,
  status: row.status as ServiceInvoiceStatus,
  leaseUntil: row.leaseUntil,
  signedDpsSha256: row.signedDpsSha256,
  layoutPackage: row.layoutPackage,
  nfseAccessKey: row.nfseAccessKey,
  authorizedAt: row.authorizedAt,
  rejectionCode: row.rejectionCode,
  rejectionMessage: row.rejectionMessage,
  failureCode: row.failureCode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toAttempt = (row: AttemptRow): TransmissionAttempt => ({
  id: row.id,
  invoiceId: row.invoiceId,
  seq: row.seq,
  state: row.state as AttemptState,
  payloadSha256: row.payloadSha256,
  preparedAt: row.preparedAt,
  sendingAt: row.sendingAt,
  closedAt: row.closedAt,
  outcome: row.outcome as AttemptOutcome | null,
  outcomeCode: row.outcomeCode,
  lookups: row.lookups,
  firstNotFoundAt: row.firstNotFoundAt,
  consecutiveLookupErrors: row.consecutiveLookupErrors,
});

/** Colunas lidas (sem o XML assinado nem o XML da NFS-e, que são grandes). */
const invoiceColumns = {
  id: serviceInvoices.id,
  companyId: serviceInvoices.companyId,
  establishmentId: serviceInvoices.establishmentId,
  clientApplicationId: serviceInvoices.clientApplicationId,
  environment: serviceInvoices.environment,
  seriesId: serviceInvoices.seriesId,
  series: serviceInvoices.series,
  number: serviceInvoices.number,
  dpsId: serviceInvoices.dpsId,
  idempotencyKey: serviceInvoices.idempotencyKey,
  requestHash: serviceInvoices.requestHash,
  externalReference: serviceInvoices.externalReference,
  payload: serviceInvoices.payload,
  status: serviceInvoices.status,
  leaseUntil: serviceInvoices.leaseUntil,
  signedDpsSha256: serviceInvoices.signedDpsSha256,
  layoutPackage: serviceInvoices.layoutPackage,
  nfseAccessKey: serviceInvoices.nfseAccessKey,
  authorizedAt: serviceInvoices.authorizedAt,
  rejectionCode: serviceInvoices.rejectionCode,
  rejectionMessage: serviceInvoices.rejectionMessage,
  failureCode: serviceInvoices.failureCode,
  createdAt: serviceInvoices.createdAt,
  updatedAt: serviceInvoices.updatedAt,
};

async function selectInvoice(tx: Transaction, where: ReturnType<typeof eq>): Promise<ServiceInvoice | undefined> {
  const rows = await tx.select(invoiceColumns).from(serviceInvoices).where(where).limit(1);
  return rows[0] === undefined ? undefined : toInvoice(rows[0] as InvoiceRow);
}

export function serviceInvoiceRepository(tx: Transaction): ServiceInvoiceRepository {
  return {
    findById: (id) => selectInvoice(tx, eq(serviceInvoices.id, id)),
    async findByIdempotencyKey(clientApplicationId, key) {
      const rows = await tx
        .select(invoiceColumns)
        .from(serviceInvoices)
        .where(and(eq(serviceInvoices.clientApplicationId, clientApplicationId), eq(serviceInvoices.idempotencyKey, key)))
        .limit(1);
      return rows[0] === undefined ? undefined : toInvoice(rows[0] as InvoiceRow);
    },
    async findActiveByExternalReference(clientApplicationId, reference) {
      const rows = await tx
        .select(invoiceColumns)
        .from(serviceInvoices)
        .where(
          and(
            eq(serviceInvoices.clientApplicationId, clientApplicationId),
            isNotNull(serviceInvoices.externalReference),
            eq(serviceInvoices.externalReference, reference),
            notInArray(serviceInvoices.status, ['REJECTED', 'FAILED']),
          ),
        )
        .limit(1);
      return rows[0] === undefined ? undefined : toInvoice(rows[0] as InvoiceRow);
    },
    async insert(invoice) {
      // SQL explícito: a API só tem INSERT nas colunas do pedido (estado e datas ficam no padrão).
      await tx.execute(sql`
        insert into service_invoices (id, company_id, establishment_id, client_application_id, environment, series_id, series, number,
          dps_id, idempotency_key, request_hash, external_reference, payload)
        values (${invoice.id}, ${invoice.companyId}, ${invoice.establishmentId}, ${invoice.clientApplicationId}, ${invoice.environment},
          ${invoice.seriesId}, ${invoice.series}, ${invoice.number}, ${invoice.dpsId}, ${invoice.idempotencyKey}, ${invoice.requestHash},
          ${invoice.externalReference}, ${JSON.stringify(invoice.payload)}::jsonb)`);
      const found = await selectInvoice(tx, eq(serviceInvoices.id, invoice.id));
      if (found === undefined) throw new Error('INSERT sem linha');
      return found;
    },
  };
}

export function serviceInvoiceWorkerRepository(tx: Transaction): ServiceInvoiceWorkerRepository {
  return {
    findById: (id) => selectInvoice(tx, eq(serviceInvoices.id, id)),
    async signedDps(id) {
      const rows = await tx.select({ xml: serviceInvoices.signedDps }).from(serviceInvoices).where(eq(serviceInvoices.id, id)).limit(1);
      return rows[0]?.xml ?? undefined;
    },
    async changeStatus(id, from, to, change = {}) {
      const rows = await tx
        .update(serviceInvoices)
        .set({
          status: to,
          ...(change.leaseUntil === undefined ? {} : { leaseUntil: change.leaseUntil }),
          ...(change.signedDps === undefined
            ? {}
            : { signedDps: change.signedDps.xml, signedDpsSha256: change.signedDps.sha256, layoutPackage: change.signedDps.layoutPackage }),
          ...(change.authorization === undefined
            ? {}
            : { nfseAccessKey: change.authorization.accessKey, nfseXml: change.authorization.nfseXml, authorizedAt: change.authorization.authorizedAt }),
          ...(change.rejection === undefined ? {} : { rejectionCode: change.rejection.code, rejectionMessage: change.rejection.message }),
          ...(change.failureCode === undefined ? {} : { failureCode: change.failureCode }),
        })
        .where(and(eq(serviceInvoices.id, id), eq(serviceInvoices.status, from)))
        .returning({ id: serviceInvoices.id });
      return rows.length === 1;
    },
    async storeSignedDps(id, signed) {
      await tx
        .update(serviceInvoices)
        .set({ signedDps: signed.xml, signedDpsSha256: signed.sha256, layoutPackage: signed.layoutPackage })
        .where(eq(serviceInvoices.id, id));
    },
  };
}

export function attemptRepository(tx: Transaction): AttemptRepository {
  const one = async (where: ReturnType<typeof and>) => {
    const rows = await tx.select().from(serviceInvoiceAttempts).where(where).orderBy(desc(serviceInvoiceAttempts.seq)).limit(1);
    return rows[0] === undefined ? undefined : toAttempt(rows[0]);
  };
  return {
    open: (invoiceId) => one(and(eq(serviceInvoiceAttempts.invoiceId, invoiceId), sql`${serviceInvoiceAttempts.state} <> 'CLOSED'`)),
    last: (invoiceId) => one(and(eq(serviceInvoiceAttempts.invoiceId, invoiceId))),
    async anySent(invoiceId) {
      const rows = await tx
        .select({ id: serviceInvoiceAttempts.id })
        .from(serviceInvoiceAttempts)
        .where(and(eq(serviceInvoiceAttempts.invoiceId, invoiceId), isNotNull(serviceInvoiceAttempts.sendingAt)))
        .limit(1);
      return rows.length > 0;
    },
    async insert(attempt) {
      await tx.execute(sql`
        insert into service_invoice_attempts (id, company_id, invoice_id, seq, payload_sha256)
        values (${attempt.id}, ${attempt.companyId}, ${attempt.invoiceId}, ${attempt.seq}, ${attempt.payloadSha256})`);
      const found = await one(and(eq(serviceInvoiceAttempts.id, attempt.id)));
      if (found === undefined) throw new Error('INSERT sem linha');
      return found;
    },
    async markSending(attemptId, at) {
      await tx.update(serviceInvoiceAttempts).set({ state: 'SENDING', sendingAt: at }).where(eq(serviceInvoiceAttempts.id, attemptId));
    },
    async close(attemptId, outcome, outcomeCode, at) {
      await tx.update(serviceInvoiceAttempts).set({ state: 'CLOSED', outcome, outcomeCode, closedAt: at }).where(eq(serviceInvoiceAttempts.id, attemptId));
    },
    async recordLookup(attemptId, state) {
      await tx
        .update(serviceInvoiceAttempts)
        .set({
          lookups: sql`${serviceInvoiceAttempts.lookups} + 1`,
          firstNotFoundAt: state.firstNotFoundAt,
          consecutiveLookupErrors: state.consecutiveLookupErrors,
        })
        .where(eq(serviceInvoiceAttempts.id, attemptId));
    },
  };
}

export interface NfseExternalPorts {
  readonly establishmentsFor: (tx: Transaction) => EstablishmentReader;
  readonly seriesFor: (tx: Transaction) => SeriesAllocator;
  readonly productionFor: (tx: Transaction) => ProductionGate;
  readonly auditFor: (tx: Transaction) => AuditTrail;
  readonly jobsFor: (tx: Transaction) => JobScheduler;
}

export function nfseApiUnitOfWork(transactions: CompanyTransactions, ports: NfseExternalPorts): UnitOfWork<NfseApiRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      invoices: serviceInvoiceRepository(tx),
      establishments: ports.establishmentsFor(tx),
      series: ports.seriesFor(tx),
      production: ports.productionFor(tx),
      audit: ports.auditFor(tx),
      jobs: ports.jobsFor(tx),
    }),
    NFSE_CONSTRAINTS,
  );
}

export function nfseWorkerUnitOfWork(
  transactions: CompanyTransactions,
  ports: Pick<NfseExternalPorts, 'productionFor' | 'auditFor' | 'jobsFor'> & { readonly outboxFor: (tx: Transaction) => EventOutbox },
): UnitOfWork<NfseWorkerRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      invoices: serviceInvoiceWorkerRepository(tx),
      attempts: attemptRepository(tx),
      production: ports.productionFor(tx),
      audit: ports.auditFor(tx),
      jobs: ports.jobsFor(tx),
      events: ports.outboxFor(tx),
    }),
    NFSE_CONSTRAINTS,
  );
}
