import { sql } from 'drizzle-orm';
import { char, check, foreignKey, index, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Tabelas do contexto Company (docs/architecture/02 e 08).
 * Somente infraestrutura: o domínio não conhece estes tipos (ADR-0004).
 * RLS, papéis e grants ficam na migration de segurança, em SQL explícito (ADR-0011).
 */

/** Empresa = contribuinte raiz. A política de RLS desta tabela usa `id`. */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    rootCnpj: varchar('root_cnpj', { length: 8 }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_companies_root_cnpj').on(t.rootCnpj),
    check('ck_companies_status', sql`${t.status} in ('ACTIVE', 'SUSPENDED')`),
    check('ck_companies_root_cnpj', sql`${t.rootCnpj} ~ '^[0-9A-Z]{8}$'`),
  ],
);

export const establishments = pgTable(
  'establishments',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    tradeName: text('trade_name').notNull(),
    municipalityCode: char('municipality_code', { length: 7 }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'fk_establishments_company', columns: [t.companyId], foreignColumns: [companies.id] }),
    // CNPJ é único no sistema: o mesmo estabelecimento não pode pertencer a duas empresas.
    unique('uq_establishments_cnpj').on(t.cnpj),
    // Alvo de FKs compostas (company_id, id) das tabelas filhas: impede referência entre companies.
    unique('uq_establishments_company_id').on(t.companyId, t.id),
    check('ck_establishments_status', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
    check('ck_establishments_cnpj', sql`${t.cnpj} ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    check('ck_establishments_municipality', sql`${t.municipalityCode} ~ '^[0-9]{7}$'`),
    index('ix_establishments_company').on(t.companyId),
  ],
);
