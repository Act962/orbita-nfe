import { sql } from 'drizzle-orm';
import { char, check, foreignKey, index, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Tabelas do contexto Taxpayer (docs/architecture/02 e 08).
 * Somente infraestrutura: o domínio não conhece estes tipos (ADR-0004).
 * RLS, papéis e grants ficam na migration de segurança, em SQL explícito (ADR-0011).
 */

/** Tenant = contribuinte raiz. A política de RLS desta tabela usa `id`. */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    rootCnpj: varchar('root_cnpj', { length: 8 }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_tenants_root_cnpj').on(t.rootCnpj),
    check('ck_tenants_status', sql`${t.status} in ('ACTIVE', 'SUSPENDED')`),
    check('ck_tenants_root_cnpj', sql`${t.rootCnpj} ~ '^[0-9A-Z]{8}$'`),
  ],
);

export const establishments = pgTable(
  'establishments',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    tradeName: text('trade_name').notNull(),
    municipalityCode: char('municipality_code', { length: 7 }).notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'fk_establishments_tenant', columns: [t.tenantId], foreignColumns: [tenants.id] }),
    // CNPJ é único no sistema: o mesmo estabelecimento não pode pertencer a dois tenants.
    unique('uq_establishments_cnpj').on(t.cnpj),
    // Alvo de FKs compostas (tenant_id, id) das tabelas filhas: impede referência entre tenants.
    unique('uq_establishments_tenant_id').on(t.tenantId, t.id),
    check('ck_establishments_status', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
    check('ck_establishments_cnpj', sql`${t.cnpj} ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    check('ck_establishments_municipality', sql`${t.municipalityCode} ~ '^[0-9]{7}$'`),
    index('ix_establishments_tenant').on(t.tenantId),
  ],
);
