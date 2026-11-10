import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { bytea } from '../../../../shared/infrastructure/database/columns.js';

/**
 * Certificados A1 (ADR-0009, docs/architecture/13).
 *
 * Grants de coluna na migration de segurança: a API insere e lê SÓ metadados (nunca
 * `wrapped_dek`, `pfx_sealed`, `password_sealed`); o worker-fiscal lê tudo; o worker-general lê
 * só o necessário para alertas de vencimento. Um trigger impõe as transições de status e a
 * imutabilidade do envelope. A FK composta para establishments fica na migration SQL.
 */
export const certificates = pgTable(
  'certificates',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    establishmentId: uuid('establishment_id').notNull(),
    status: text('status').notNull().default('PENDING_VALIDATION'),
    rejectionReason: text('rejection_reason'),
    // Metadados (preenchidos pelo worker-fiscal na validação).
    subjectCnpj: varchar('subject_cnpj', { length: 14 }),
    subjectName: text('subject_name'),
    issuerName: text('issuer_name'),
    serialNumber: text('serial_number'),
    notBefore: timestamp('not_before', { withTimezone: true }),
    notAfter: timestamp('not_after', { withTimezone: true }),
    thumbprintSha256: varchar('thumbprint_sha256', { length: 64 }),
    // Envelope (ADR-0009). wrapped_dek = NULL após revogação: destruição criptográfica.
    envelopeVersion: integer('envelope_version').notNull(),
    kekId: varchar('kek_id', { length: 16 }).notNull(),
    wrappedDek: bytea('wrapped_dek'),
    pfxSealed: bytea('pfx_sealed').notNull(),
    passwordSealed: bytea('password_sealed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_certificates_status', sql`${t.status} in ('PENDING_VALIDATION', 'ACTIVE', 'REJECTED', 'REPLACED', 'REVOKED')`),
    check('ck_certificates_rejection', sql`(${t.status} = 'REJECTED') = (${t.rejectionReason} is not null)`),
    check('ck_certificates_revoked', sql`(${t.status} = 'REVOKED') = (${t.revokedAt} is not null) and (${t.status} <> 'REVOKED' or ${t.wrappedDek} is null)`),
    check('ck_certificates_envelope', sql`${t.status} = 'REVOKED' or ${t.wrappedDek} is not null`),
    check(
      'ck_certificates_metadata',
      sql`${t.status} not in ('ACTIVE', 'REPLACED') or (${t.thumbprintSha256} is not null and ${t.notAfter} is not null and ${t.subjectCnpj} is not null)`,
    ),
    check('ck_certificates_thumbprint', sql`${t.thumbprintSha256} is null or ${t.thumbprintSha256} ~ '^[0-9a-f]{64}$'`),
    check('ck_certificates_kek_id', sql`${t.kekId} ~ '^[0-9a-f]{16}$'`),
    // Um único certificado ativo por estabelecimento; a troca acontece numa só transação.
    uniqueIndex('uq_certificates_active').on(t.establishmentId).where(sql`${t.status} = 'ACTIVE'`),
    index('ix_certificates_establishment').on(t.companyId, t.establishmentId),
    index('ix_certificates_expiry').on(t.notAfter).where(sql`${t.status} = 'ACTIVE'`),
  ],
);
