import { sql } from 'drizzle-orm';
import { check, customType, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Tabelas do contexto IAM (docs/architecture/02 §1, 08 §3; ADR-0012).
 *
 * `client_applications` e `credentials` NÃO pertencem a uma empresa: a credencial é resolvida
 * antes de existir contexto de empresa. Estão na allowlist revisada do meta-teste de RLS, e
 * o acesso é restrito por grants (a API só lê; a escrita é do papel fiscal_admin).
 * `company_grants` tem company_id e RLS forçado como qualquer tabela de empresa.
 *
 * A FK company_grants.company_id → companies.id fica na migration SQL (o schema de outro módulo
 * não é importado aqui).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const clientApplications = pgTable(
  'client_applications',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_client_applications_name').on(t.name),
    check('ck_client_applications_status', sql`${t.status} in ('ACTIVE', 'DISABLED')`),
  ],
);

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey(),
    clientApplicationId: uuid('client_application_id').notNull(),
    /** Parte pública da API key (16 hex). */
    keyId: varchar('key_id', { length: 16 }).notNull(),
    /** HMAC-SHA256(pepper, segredo). O segredo nunca é gravado. */
    secretHash: bytea('secret_hash').notNull(),
    environment: text('environment').notNull(),
    scopes: text('scopes').array().notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: 'fk_credentials_client_application', columns: [t.clientApplicationId], foreignColumns: [clientApplications.id] }),
    unique('uq_credentials_key_id').on(t.keyId),
    check('ck_credentials_key_id', sql`${t.keyId} ~ '^[0-9a-f]{16}$'`),
    check('ck_credentials_secret_hash', sql`octet_length(${t.secretHash}) = 32`),
    check('ck_credentials_environment', sql`${t.environment} in ('live', 'test')`),
    check('ck_credentials_scopes', sql`cardinality(${t.scopes}) > 0`),
    check('ck_credentials_status', sql`${t.status} in ('ACTIVE', 'REVOKED')`),
    check('ck_credentials_revoked_at', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} is not null)`),
    index('ix_credentials_client_application').on(t.clientApplicationId),
  ],
);

export const companyGrants = pgTable(
  'company_grants',
  {
    companyId: uuid('company_id').notNull(),
    clientApplicationId: uuid('client_application_id').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_company_grants', columns: [t.companyId, t.clientApplicationId] }),
    foreignKey({ name: 'fk_company_grants_client_application', columns: [t.clientApplicationId], foreignColumns: [clientApplications.id] }),
    check('ck_company_grants_status', sql`${t.status} in ('ACTIVE', 'REVOKED')`),
    index('ix_company_grants_client_application').on(t.clientApplicationId),
  ],
);
