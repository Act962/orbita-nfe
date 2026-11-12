import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * NFS-e (ADR-0032). FKs compostas para establishments e document_series, RLS, grants por
 * coluna e triggers de transição/imutabilidade ficam na migration SQL de segurança.
 */
export const serviceInvoices = pgTable(
  'service_invoices',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    clientApplicationId: uuid('client_application_id').notNull(),
    environment: text('environment').notNull(),
    seriesId: uuid('series_id').notNull(),
    series: varchar('series', { length: 5 }).notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    dpsId: varchar('dps_id', { length: 45 }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    externalReference: text('external_reference'),
    /** Dados da DPS enviados pelo cliente (contrato da próxima etapa). Imutável. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    /** Concessão do processamento: só a recuperação mexe num PROCESSING com concessão vencida. */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** DPS assinada: gravada uma vez, antes da 1ª transmissão; toda retransmissão usa estes bytes. */
    signedDps: text('signed_dps'),
    signedDpsSha256: char('signed_dps_sha256', { length: 64 }),
    /** Pacote XSD usado na validação (ADR-0013), com as erratas aplicadas. */
    layoutPackage: text('layout_package'),
    nfseAccessKey: varchar('nfse_access_key', { length: 50 }),
    nfseXml: text('nfse_xml'),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    rejectionCode: text('rejection_code'),
    rejectionMessage: text('rejection_message'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_service_invoices_company_id').on(t.companyId, t.id),
    unique('uq_service_invoices_dps_id').on(t.dpsId),
    unique('uq_service_invoices_series_number').on(t.seriesId, t.number),
    unique('uq_service_invoices_idempotency').on(t.companyId, t.clientApplicationId, t.idempotencyKey),
    // A referência externa só volta a ficar livre depois de falha definitiva (ADR-0026 item 1).
    uniqueIndex('uq_service_invoices_external_reference')
      .on(t.companyId, t.clientApplicationId, t.externalReference)
      .where(sql`${t.externalReference} is not null and ${t.status} not in ('REJECTED', 'FAILED')`),
    check('ck_service_invoices_status', sql`${t.status} in ('PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED', 'UNKNOWN')`),
    check('ck_service_invoices_environment', sql`${t.environment} in ('PRODUCTION', 'HOMOLOGATION')`),
    check('ck_service_invoices_dps_id', sql`${t.dpsId} ~ '^DPS[0-9]{7}(1[0-9]{14}|2[0-9A-Z]{14})[0-9]{20}$'`),
    check('ck_service_invoices_number', sql`${t.number} between 1 and 999999999999999`),
    check('ck_service_invoices_idempotency_key', sql`length(${t.idempotencyKey}) between 1 and 255`),
    check('ck_service_invoices_external_reference', sql`${t.externalReference} is null or length(${t.externalReference}) between 1 and 255`),
    check('ck_service_invoices_signed', sql`(${t.signedDps} is null) = (${t.signedDpsSha256} is null)`),
    check('ck_service_invoices_authorized', sql`${t.status} <> 'AUTHORIZED' or ${t.nfseAccessKey} is not null`),
    index('ix_service_invoices_company_created').on(t.companyId, t.createdAt),
  ],
);

/** Tentativas de transmissão (write-ahead, ADR-0022). No máximo uma aberta por documento. */
export const serviceInvoiceAttempts = pgTable(
  'service_invoice_attempts',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    seq: integer('seq').notNull(),
    state: text('state').notNull().default('PREPARED'),
    payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
    sendingAt: timestamp('sending_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** AUTHORIZED | REJECTED | NOT_SENT | UNKNOWN | ALREADY_EXISTS | RECOVERED_NOT_SENT | RECOVERED_UNKNOWN */
    outcome: text('outcome'),
    /** Código do erro de transporte ou da rejeição oficial. Nunca mensagem livre. */
    outcomeCode: text('outcome_code'),
    /** Reconciliação desta tentativa (doc 12 §3). */
    lookups: integer('lookups').notNull().default(0),
    firstNotFoundAt: timestamp('first_not_found_at', { withTimezone: true }),
    consecutiveLookupErrors: integer('consecutive_lookup_errors').notNull().default(0),
  },
  (t) => [
    unique('uq_service_invoice_attempts_seq').on(t.invoiceId, t.seq),
    uniqueIndex('uq_service_invoice_attempts_open').on(t.invoiceId).where(sql`${t.state} <> 'CLOSED'`),
    check('ck_service_invoice_attempts_state', sql`${t.state} in ('PREPARED', 'SENDING', 'CLOSED')`),
    check(
      'ck_service_invoice_attempts_outcome',
      sql`${t.outcome} is null or ${t.outcome} in ('AUTHORIZED', 'REJECTED', 'NOT_SENT', 'UNKNOWN', 'ALREADY_EXISTS', 'RECOVERED_NOT_SENT', 'RECOVERED_UNKNOWN')`,
    ),
    check('ck_service_invoice_attempts_closed', sql`(${t.state} = 'CLOSED') = (${t.outcome} is not null)`),
    check('ck_service_invoice_attempts_sending', sql`${t.state} = 'PREPARED' or ${t.sendingAt} is not null or ${t.outcome} = 'RECOVERED_NOT_SENT'`),
    index('ix_service_invoice_attempts_company').on(t.companyId),
  ],
);
