import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Séries de documentos (ADR-0008). A FK composta (company_id, establishment_id) →
 * establishments(company_id, id) e o trigger que impede o número de voltar ficam na migration
 * SQL de segurança (o schema de outro módulo não é importado aqui).
 */
export const documentSeries = pgTable(
  'document_series',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    kind: text('kind').notNull(),
    environment: text('environment').notNull(),
    series: varchar('series', { length: 5 }).notNull(),
    // Até 15 dígitos (DPS): cabe em Number.MAX_SAFE_INTEGER (16 dígitos).
    nextNumber: bigint('next_number', { mode: 'number' }).notNull(),
    maxNumber: bigint('max_number', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_document_series_key').on(t.establishmentId, t.kind, t.environment, t.series),
    check('ck_document_series_kind', sql`${t.kind} in ('NFSE_DPS', 'NFE', 'NFCE')`),
    check('ck_document_series_environment', sql`${t.environment} in ('PRODUCTION', 'HOMOLOGATION')`),
    check('ck_document_series_series', sql`${t.series} ~ '^(0|[1-9][0-9]{0,4})$'`),
    check('ck_document_series_status', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
    // next_number = max_number + 1 significa série esgotada.
    check('ck_document_series_numbers', sql`${t.maxNumber} between 1 and 999999999999999 and ${t.nextNumber} between 1 and ${t.maxNumber} + 1`),
    index('ix_document_series_company').on(t.companyId),
  ],
);

/**
 * Habilitação de produção por estabelecimento e modalidade (ADR-0027). No máximo uma ACTIVE por
 * (estabelecimento, modalidade). Na migration de segurança: FK composta para establishments,
 * RLS, grants por coluna e trigger que só permite ACTIVE → REVOKED (o resto é imutável).
 */
export const productionEnablements = pgTable(
  'production_enablements',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
  },
  (t) => [
    uniqueIndex('uq_production_enablements_active').on(t.establishmentId, t.kind).where(sql`${t.status} = 'ACTIVE'`),
    check('ck_production_enablements_kind', sql`${t.kind} in ('NFSE_DPS', 'NFE', 'NFCE')`),
    check('ck_production_enablements_status', sql`${t.status} in ('ACTIVE', 'REVOKED')`),
    check(
      'ck_production_enablements_revocation',
      sql`(${t.status} = 'ACTIVE' and ${t.revokedAt} is null and ${t.revocationReason} is null) or (${t.status} = 'REVOKED' and ${t.revokedAt} is not null and length(${t.revocationReason}) between 1 and 300)`,
    ),
    index('ix_production_enablements_company').on(t.companyId),
  ],
);
