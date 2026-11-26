import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
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
  FiscalEnvironment,
  NfceApiRepositories,
  NfceIssuerReader,
  NfceProductionGate,
  NfceSeriesAllocator,
} from '../../application/ports.js';
import type { ConsumerSale } from '../../domain/consumer-sale.js';
import type { ConsumerInvoiceStatus } from '../../domain/consumer-invoice.js';
import { consumerInvoices } from './schema.js';

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
