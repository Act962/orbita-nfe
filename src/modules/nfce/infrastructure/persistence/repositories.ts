import { createHash } from 'node:crypto';
import { and, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import { ConflictError, NotFoundError } from '../../../../shared/application/errors.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import { NFCE_IDEMPOTENCY_RACE } from '../../application/consumer-invoice-service.js';
import type {
  ConsumerInvoice,
  ConsumerInvoiceRepository,
  ConsumerInvoiceWorkerRepository,
  FiscalEnvironment,
  NfceApiRepositories,
  NfceAttempt,
  NfceAttemptRepository,
  NfceIssuerReader,
  NfceProductionGate,
  NfceSeriesAllocator,
  NfceWorkerRepositories,
} from '../../application/ports.js';
import type { ConsumerSale } from '../../domain/consumer-sale.js';
import type { AttemptOutcome, AttemptState, ConsumerInvoiceStatus } from '../../domain/consumer-invoice.js';
import { consumerInvoiceAttempts, consumerInvoices } from './schema.js';

export const NFCE_CONSTRAINTS: ConstraintErrorMap = {
  // Corrida na mesma Idempotency-Key: o serviço relê a vencedora numa transação nova.
  uq_consumer_invoices_idempotency: () => new ConflictError(NFCE_IDEMPOTENCY_RACE, 'Requisição repetida em paralelo.'),
  uq_consumer_invoices_external_reference: () => new ConflictError('DOCUMENT_IN_PROGRESS', 'Já existe NFC-e em andamento com esta referência externa. Não reemita.'),
  fk_consumer_invoices_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
};

/** Colunas da nota sem o XML autorizado (que só sai no download). */
const invoiceColumns = {
  id: consumerInvoices.id,
  companyId: consumerInvoices.companyId,
  establishmentId: consumerInvoices.establishmentId,
  clientApplicationId: consumerInvoices.clientApplicationId,
  environment: consumerInvoices.environment,
  seriesId: consumerInvoices.seriesId,
  series: consumerInvoices.series,
  number: consumerInvoices.number,
  numericCode: consumerInvoices.numericCode,
  idempotencyKey: consumerInvoices.idempotencyKey,
  requestHash: consumerInvoices.requestHash,
  externalReference: consumerInvoices.externalReference,
  payload: consumerInvoices.payload,
  status: consumerInvoices.status,
  leaseUntil: consumerInvoices.leaseUntil,
  accessKey: consumerInvoices.accessKey,
  protocolNumber: consumerInvoices.protocolNumber,
  authorizerStatusCode: consumerInvoices.authorizerStatusCode,
  authorizedAt: consumerInvoices.authorizedAt,
  rejectionCode: consumerInvoices.rejectionCode,
  rejectionMessage: consumerInvoices.rejectionMessage,
  failureCode: consumerInvoices.failureCode,
  createdAt: consumerInvoices.createdAt,
  updatedAt: consumerInvoices.updatedAt,
};

type InvoiceRow = { [K in keyof typeof invoiceColumns]: (typeof consumerInvoices.$inferSelect)[K] };

const toInvoice = (row: InvoiceRow): ConsumerInvoice => ({
  id: row.id,
  companyId: row.companyId,
  establishmentId: row.establishmentId,
  clientApplicationId: row.clientApplicationId,
  environment: row.environment as FiscalEnvironment,
  seriesId: row.seriesId,
  series: row.series,
  number: row.number,
  numericCode: row.numericCode,
  idempotencyKey: row.idempotencyKey,
  requestHash: row.requestHash,
  externalReference: row.externalReference,
  sale: row.payload as ConsumerSale,
  status: row.status as ConsumerInvoiceStatus,
  leaseUntil: row.leaseUntil,
  accessKey: row.accessKey,
  protocolNumber: row.protocolNumber,
  authorizerStatusCode: row.authorizerStatusCode,
  authorizedAt: row.authorizedAt,
  rejectionCode: row.rejectionCode,
  rejectionMessage: row.rejectionMessage,
  failureCode: row.failureCode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

async function selectOne(tx: Transaction, where: ReturnType<typeof and>): Promise<ConsumerInvoice | undefined> {
  const rows = await tx.select(invoiceColumns).from(consumerInvoices).where(where).limit(1);
  return rows[0] === undefined ? undefined : toInvoice(rows[0]);
}

export function consumerInvoiceRepository(tx: Transaction): ConsumerInvoiceRepository {
  return {
    findById: (id) => selectOne(tx, eq(consumerInvoices.id, id)),
    findByIdempotencyKey: (clientApplicationId, key) =>
      selectOne(tx, and(eq(consumerInvoices.clientApplicationId, clientApplicationId), eq(consumerInvoices.idempotencyKey, key))),
    findActiveByExternalReference: (clientApplicationId, environment, reference) =>
      selectOne(
        tx,
        and(
          eq(consumerInvoices.clientApplicationId, clientApplicationId),
          eq(consumerInvoices.environment, environment),
          eq(consumerInvoices.externalReference, reference),
          notInArray(consumerInvoices.status, ['REJECTED', 'FAILED']),
        ),
      ),
    async listByExternalReference(clientApplicationId, environment, reference, limit) {
      const rows = await tx
        .select(invoiceColumns)
        .from(consumerInvoices)
        .where(and(eq(consumerInvoices.clientApplicationId, clientApplicationId), eq(consumerInvoices.environment, environment), eq(consumerInvoices.externalReference, reference)))
        .orderBy(desc(consumerInvoices.createdAt), desc(consumerInvoices.id))
        .limit(limit);
      return rows.map(toInvoice);
    },
    async insert(invoice) {
      // SQL explícito: a API só tem INSERT nas colunas do pedido (estado e datas ficam no padrão).
      await tx.execute(sql`
        insert into consumer_invoices (id, company_id, establishment_id, client_application_id, environment, series_id, series, number,
          numeric_code, idempotency_key, request_hash, external_reference, payload)
        values (${invoice.id}, ${invoice.companyId}, ${invoice.establishmentId}, ${invoice.clientApplicationId}, ${invoice.environment},
          ${invoice.seriesId}, ${invoice.series}, ${invoice.number}, ${invoice.numericCode}, ${invoice.idempotencyKey}, ${invoice.requestHash},
          ${invoice.externalReference}, ${JSON.stringify(invoice.sale)}::jsonb)`);
      const found = await selectOne(tx, eq(consumerInvoices.id, invoice.id));
      if (found === undefined) throw new Error('INSERT sem linha');
      return found;
    },
  };
}

// ------------------------------------------------------------------ worker-fiscal (ADR-0072, fatia 3)

export function consumerInvoiceWorkerRepository(tx: Transaction): ConsumerInvoiceWorkerRepository {
  return {
    findById: (id) => selectOne(tx, eq(consumerInvoices.id, id)),
    async changeStatus(id, from, to, change = {}) {
      const settled = change.settled;
      const rows = await tx
        .update(consumerInvoices)
        .set({
          status: to,
          ...(change.leaseUntil === undefined ? {} : { leaseUntil: change.leaseUntil }),
          ...(settled === undefined
            ? {}
            : {
                accessKey: settled.accessKey,
                authorizerStatusCode: settled.statusCode,
                protocolNumber: settled.protocolNumber,
                ...(settled.nfeProcXml === undefined
                  ? {}
                  : {
                      nfeProcXml: settled.nfeProcXml,
                      // Junto com o XML: o arquivamento futuro confere estes bytes (como no ADR-0048).
                      nfeProcXmlSha256: createHash('sha256').update(settled.nfeProcXml, 'utf8').digest('hex'),
                      authorizedAt: settled.at,
                    }),
              }),
          ...(change.rejection === undefined ? {} : { rejectionCode: change.rejection.code, rejectionMessage: change.rejection.message }),
          ...(change.failureCode === undefined ? {} : { failureCode: change.failureCode }),
        })
        .where(and(eq(consumerInvoices.id, id), eq(consumerInvoices.status, from)))
        .returning({ id: consumerInvoices.id });
      return rows.length === 1;
    },
  };
}

type AttemptRow = typeof consumerInvoiceAttempts.$inferSelect;

/** Colunas da tentativa sem o XML assinado (lido só quando preciso). */
const attemptColumns = {
  id: consumerInvoiceAttempts.id,
  invoiceId: consumerInvoiceAttempts.invoiceId,
  seq: consumerInvoiceAttempts.seq,
  state: consumerInvoiceAttempts.state,
  accessKey: consumerInvoiceAttempts.accessKey,
  issuedAt: consumerInvoiceAttempts.issuedAt,
  payloadSha256: consumerInvoiceAttempts.payloadSha256,
  digestValue: consumerInvoiceAttempts.digestValue,
  preparedAt: consumerInvoiceAttempts.preparedAt,
  sendingAt: consumerInvoiceAttempts.sendingAt,
  closedAt: consumerInvoiceAttempts.closedAt,
  outcome: consumerInvoiceAttempts.outcome,
  outcomeCode: consumerInvoiceAttempts.outcomeCode,
  lookups: consumerInvoiceAttempts.lookups,
  firstNotFoundAt: consumerInvoiceAttempts.firstNotFoundAt,
  consecutiveLookupErrors: consumerInvoiceAttempts.consecutiveLookupErrors,
};

const toAttempt = (row: Omit<AttemptRow, 'companyId' | 'signedXml'>): NfceAttempt => ({
  ...row,
  state: row.state as AttemptState,
  outcome: row.outcome as AttemptOutcome | null,
});

export function nfceAttemptRepository(tx: Transaction): NfceAttemptRepository {
  const one = async (where: ReturnType<typeof and>): Promise<NfceAttempt | undefined> => {
    const rows = await tx.select(attemptColumns).from(consumerInvoiceAttempts).where(where).orderBy(desc(consumerInvoiceAttempts.seq)).limit(1);
    return rows[0] === undefined ? undefined : toAttempt(rows[0]);
  };
  return {
    open: (invoiceId) => one(and(eq(consumerInvoiceAttempts.invoiceId, invoiceId), sql`${consumerInvoiceAttempts.state} <> 'CLOSED'`)),
    last: (invoiceId) => one(eq(consumerInvoiceAttempts.invoiceId, invoiceId)),
    async signedXml(attemptId) {
      const rows = await tx.select({ xml: consumerInvoiceAttempts.signedXml }).from(consumerInvoiceAttempts).where(eq(consumerInvoiceAttempts.id, attemptId)).limit(1);
      return rows[0]?.xml;
    },
    async anySent(invoiceId) {
      const rows = await tx
        .select({ id: consumerInvoiceAttempts.id })
        .from(consumerInvoiceAttempts)
        .where(and(eq(consumerInvoiceAttempts.invoiceId, invoiceId), isNotNull(consumerInvoiceAttempts.sendingAt)))
        .limit(1);
      return rows.length > 0;
    },
    async insert(attempt) {
      await tx.execute(sql`
        insert into consumer_invoice_attempts (id, company_id, invoice_id, seq, access_key, issued_at, signed_xml, payload_sha256, digest_value)
        values (${attempt.id}, ${attempt.companyId}, ${attempt.invoiceId}, ${attempt.seq}, ${attempt.accessKey}, ${attempt.issuedAt},
          ${attempt.signedXml}, ${attempt.payloadSha256}, ${attempt.digestValue})`);
      const found = await one(eq(consumerInvoiceAttempts.id, attempt.id));
      if (found === undefined) throw new Error('INSERT sem linha');
      return found;
    },
    async markSending(attemptId, at) {
      await tx.update(consumerInvoiceAttempts).set({ state: 'SENDING', sendingAt: at }).where(eq(consumerInvoiceAttempts.id, attemptId));
    },
    async close(attemptId, outcome, outcomeCode, at) {
      await tx.update(consumerInvoiceAttempts).set({ state: 'CLOSED', outcome, outcomeCode, closedAt: at }).where(eq(consumerInvoiceAttempts.id, attemptId));
    },
    async recordLookup(attemptId, state) {
      await tx
        .update(consumerInvoiceAttempts)
        .set({ lookups: sql`${consumerInvoiceAttempts.lookups} + 1`, firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: state.consecutiveLookupErrors })
        .where(eq(consumerInvoiceAttempts.id, attemptId));
    },
  };
}

export function nfceWorkerUnitOfWork(transactions: CompanyTransactions, ports: Pick<NfceExternalPorts, 'productionFor' | 'auditFor' | 'jobsFor'>): UnitOfWork<NfceWorkerRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      invoices: consumerInvoiceWorkerRepository(tx),
      attempts: nfceAttemptRepository(tx),
      production: ports.productionFor(tx),
      audit: ports.auditFor(tx),
      jobs: ports.jobsFor(tx),
    }),
    NFCE_CONSTRAINTS,
  );
}

export interface NfceExternalPorts {
  readonly issuersFor: (tx: Transaction) => NfceIssuerReader;
  readonly seriesFor: (tx: Transaction) => NfceSeriesAllocator;
  readonly productionFor: (tx: Transaction) => NfceProductionGate;
  readonly auditFor: (tx: Transaction) => AuditTrail;
  readonly jobsFor: (tx: Transaction) => JobScheduler;
}

export function nfceApiUnitOfWork(transactions: CompanyTransactions, ports: NfceExternalPorts): UnitOfWork<NfceApiRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      invoices: consumerInvoiceRepository(tx),
      issuers: ports.issuersFor(tx),
      series: ports.seriesFor(tx),
      production: ports.productionFor(tx),
      audit: ports.auditFor(tx),
      jobs: ports.jobsFor(tx),
    }),
    NFCE_CONSTRAINTS,
  );
}
