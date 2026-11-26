import { sql } from 'drizzle-orm';
import { bigint, char, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * NFC-e (ADR-0072). FKs compostas para establishments e document_series, RLS, grants por coluna e
 * triggers de transição/imutabilidade ficam na migration SQL de segurança.
 */
export const consumerInvoices = pgTable(
  'consumer_invoices',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    clientApplicationId: uuid('client_application_id').notNull(),
    environment: text('environment').notNull(),
    seriesId: uuid('series_id').notNull(),
    series: varchar('series', { length: 3 }).notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    /** cNF da chave (regra B03-10), sorteado no aceite e o mesmo em toda tentativa. */
    numericCode: char('numeric_code', { length: 8 }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    externalReference: text('external_reference'),
    /** Venda enviada pelo cliente (contrato v1, ADR-0069). Imutável. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** Chave da nota que o autorizador gravou (autorizada ou denegada). Gravada uma vez. */
    accessKey: varchar('access_key', { length: 44 }),
    /** Protocolo e cStat da autorização ou denegação. Gravados uma vez. */
    protocolNumber: varchar('protocol_number', { length: 15 }),
    authorizerStatusCode: char('authorizer_status_code', { length: 3 }),
    /** `nfeProc` (NFe + protNFe) da nota autorizada e o SHA-256 gravado junto. */
    nfeProcXml: text('nfe_proc_xml'),
    nfeProcXmlSha256: char('nfe_proc_xml_sha256', { length: 64 }),
    /** Arquivamento no bucket com Object Lock (ADR-0074, molde do ADR-0048). Gravados uma vez. */
    nfeProcXmlObjectKey: text('nfe_proc_xml_object_key'),
    nfeProcXmlArchivedAt: timestamp('nfe_proc_xml_archived_at', { withTimezone: true }),
    nfeProcXmlRetainUntil: timestamp('nfe_proc_xml_retain_until', { withTimezone: true }),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    rejectionCode: text('rejection_code'),
    rejectionMessage: text('rejection_message'),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_consumer_invoices_company_id').on(t.companyId, t.id),
    unique('uq_consumer_invoices_series_number').on(t.seriesId, t.number),
    unique('uq_consumer_invoices_idempotency').on(t.companyId, t.clientApplicationId, t.idempotencyKey),
    uniqueIndex('uq_consumer_invoices_external_reference')
      .on(t.companyId, t.clientApplicationId, t.environment, t.externalReference)
      .where(sql`${t.externalReference} is not null and ${t.status} not in ('REJECTED', 'FAILED')`),
    index('ix_consumer_invoices_company_created').on(t.companyId, t.createdAt),
    check('ck_consumer_invoices_status', sql`${t.status} in ('PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'DENIED', 'FAILED', 'UNKNOWN')`),
    check('ck_consumer_invoices_environment', sql`${t.environment} in ('PRODUCTION', 'HOMOLOGATION')`),
    // TSerie e TNF do leiaute 4.00.
    check('ck_consumer_invoices_series', sql`${t.series} ~ '^(0|[1-9][0-9]{0,2})$'`),
    check('ck_consumer_invoices_number', sql`${t.number} between 1 and 999999999`),
    check('ck_consumer_invoices_numeric_code', sql`${t.numericCode} ~ '^[0-9]{8}$'`),
    check('ck_consumer_invoices_idempotency_key', sql`length(${t.idempotencyKey}) between 1 and 255`),
    check('ck_consumer_invoices_external_reference', sql`${t.externalReference} is null or length(${t.externalReference}) between 1 and 100`),
    check('ck_consumer_invoices_access_key', sql`${t.accessKey} is null or ${t.accessKey} ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'`),
    check('ck_consumer_invoices_settled', sql`${t.status} not in ('AUTHORIZED', 'DENIED') or (${t.accessKey} is not null and ${t.authorizerStatusCode} is not null)`),
    check('ck_consumer_invoices_authorized', sql`${t.status} <> 'AUTHORIZED' or (${t.nfeProcXml} is not null and ${t.protocolNumber} is not null)`),
    check('ck_consumer_invoices_proc_hash', sql`(${t.nfeProcXml} is null) = (${t.nfeProcXmlSha256} is null)`),
    // Arquivado = chave, data e retenção juntas, e só com o XML e o hash gravados; a chave contém o hash.
    check(
      'ck_consumer_invoices_proc_archive',
      sql`(${t.nfeProcXmlObjectKey} is null) = (${t.nfeProcXmlArchivedAt} is null) and (${t.nfeProcXmlObjectKey} is null) = (${t.nfeProcXmlRetainUntil} is null)
        and (${t.nfeProcXmlObjectKey} is null or (${t.nfeProcXml} is not null and ${t.nfeProcXmlSha256} is not null and ${t.nfeProcXmlObjectKey} like '%' || ${t.nfeProcXmlSha256} || '%'))`,
    ),
  ],
);

/**
 * Tentativas de transmissão (write-ahead, ADR-0022). Cada uma guarda o XML que montou e assinou
 * (ADR-0072: `dhEmi` no envio), a chave e o DigestValue: é por eles que a consulta reconcilia.
 */
export const consumerInvoiceAttempts = pgTable(
  'consumer_invoice_attempts',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    seq: integer('seq').notNull(),
    state: text('state').notNull().default('PREPARED'),
    accessKey: varchar('access_key', { length: 44 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    signedXml: text('signed_xml').notNull(),
    payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
    digestValue: varchar('digest_value', { length: 28 }).notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
    sendingAt: timestamp('sending_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    outcome: text('outcome'),
    outcomeCode: text('outcome_code'),
    lookups: integer('lookups').notNull().default(0),
    firstNotFoundAt: timestamp('first_not_found_at', { withTimezone: true }),
    consecutiveLookupErrors: integer('consecutive_lookup_errors').notNull().default(0),
  },
  (t) => [
    unique('uq_consumer_invoice_attempts_seq').on(t.invoiceId, t.seq),
    uniqueIndex('uq_consumer_invoice_attempts_open').on(t.invoiceId).where(sql`${t.state} <> 'CLOSED'`),
    index('ix_consumer_invoice_attempts_company').on(t.companyId),
    check('ck_consumer_invoice_attempts_state', sql`${t.state} in ('PREPARED', 'SENDING', 'CLOSED')`),
    check(
      'ck_consumer_invoice_attempts_outcome',
      sql`${t.outcome} is null or ${t.outcome} in ('AUTHORIZED', 'REJECTED', 'DENIED', 'NOT_SENT', 'UNKNOWN', 'ALREADY_EXISTS', 'RECOVERED_NOT_SENT', 'RECOVERED_UNKNOWN')`,
    ),
    check('ck_consumer_invoice_attempts_closed', sql`(${t.state} = 'CLOSED') = (${t.outcome} is not null)`),
    check('ck_consumer_invoice_attempts_sending', sql`${t.state} = 'PREPARED' or ${t.sendingAt} is not null or ${t.outcome} = 'RECOVERED_NOT_SENT'`),
    check('ck_consumer_invoice_attempts_access_key', sql`${t.accessKey} ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'`),
    check('ck_consumer_invoice_attempts_digest', sql`${t.digestValue} ~ '^[A-Za-z0-9+/]{27}=$'`),
  ],
);
