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
    /** Inscrição municipal, só cadastro (ADR-0061; TSInscMun, 1 a 15 caracteres). */
    municipalRegistration: varchar('municipal_registration', { length: 15 }),
    /** Perfil estadual para NF-e/NFC-e (ADR-0071): TIe, CRT e TEnderEmi; tudo ou nada. */
    stateRegistration: varchar('state_registration', { length: 14 }),
    taxRegime: char('tax_regime', { length: 1 }),
    addressStreet: varchar('address_street', { length: 60 }),
    addressNumber: varchar('address_number', { length: 60 }),
    addressComplement: varchar('address_complement', { length: 60 }),
    addressDistrict: varchar('address_district', { length: 60 }),
    addressPostalCode: char('address_postal_code', { length: 8 }),
    addressPhone: varchar('address_phone', { length: 14 }),
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
    check('ck_establishments_municipal_registration', sql`${t.municipalRegistration} is null or length(${t.municipalRegistration}) between 1 and 15`),
    // Perfil estadual: os obrigatórios existem juntos ou não existem (complemento e fone são opcionais).
    check(
      'ck_establishments_state_profile_complete',
      sql`(${t.stateRegistration} is null) = (${t.taxRegime} is null) and (${t.stateRegistration} is null) = (${t.addressStreet} is null)
        and (${t.stateRegistration} is null) = (${t.addressNumber} is null) and (${t.stateRegistration} is null) = (${t.addressDistrict} is null)
        and (${t.stateRegistration} is null) = (${t.addressPostalCode} is null)
        and (${t.stateRegistration} is not null or (${t.addressComplement} is null and ${t.addressPhone} is null))`,
    ),
    check('ck_establishments_state_registration', sql`${t.stateRegistration} is null or ${t.stateRegistration} ~ '^([0-9]{2,14}|ISENTO)$'`),
    check('ck_establishments_tax_regime', sql`${t.taxRegime} is null or ${t.taxRegime} in ('1', '2', '3', '4')`),
    check('ck_establishments_postal_code', sql`${t.addressPostalCode} is null or ${t.addressPostalCode} ~ '^[0-9]{8}$'`),
    check('ck_establishments_phone', sql`${t.addressPhone} is null or ${t.addressPhone} ~ '^[0-9]{6,14}$'`),
    index('ix_establishments_company').on(t.companyId),
  ],
);
