import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea } from '../../../../shared/infrastructure/database/columns.js';

/**
 * Trilha de auditoria append-only com hash encadeado (docs/architecture/14 §A4).
 *
 * Na migration de segurança: grants (a aplicação só faz INSERT; leitura só do operador),
 * RLS por empresa, trigger que bloqueia UPDATE/DELETE/TRUNCATE para TODOS os papéis e trigger
 * que confere o encadeamento (sequência + hash anterior) contra a cabeça da cadeia. As tabelas
 * de cabeça não têm nenhum grant para a aplicação: só as funções SECURITY DEFINER as tocam.
 */
const chainColumns = {
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull(),
  action: text('action').notNull(),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id').notNull(),
  credentialRef: text('credential_ref'),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  correlationId: text('correlation_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  prevHash: bytea('prev_hash').notNull(),
  hash: bytea('hash').notNull(),
};

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    ...chainColumns,
  },
  (t) => [
    unique('uq_audit_log_sequence').on(t.companyId, t.sequence),
    check('ck_audit_log_sequence', sql`${t.sequence} >= 1`),
    check('ck_audit_log_hashes', sql`octet_length(${t.prevHash}) = 32 and octet_length(${t.hash}) = 32`),
    check('ck_audit_log_actor_kind', sql`${t.actorKind} in ('CLIENT_APPLICATION', 'OPERATOR', 'SYSTEM')`),
    index('ix_audit_log_subject').on(t.companyId, t.subjectType, t.subjectId),
  ],
);

export const auditChainHeads = pgTable(
  'audit_chain_heads',
  {
    companyId: uuid('company_id').primaryKey(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
    lastHash: bytea('last_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('ck_audit_chain_heads_hash', sql`octet_length(${t.lastHash}) = 32`)],
);

/** Cadeia da plataforma: ações do operador sem empresa (aplicações e credenciais). */
export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: uuid('id').primaryKey(),
    ...chainColumns,
  },
  (t) => [
    unique('uq_platform_audit_log_sequence').on(t.sequence),
    check('ck_platform_audit_log_sequence', sql`${t.sequence} >= 1`),
    check('ck_platform_audit_log_hashes', sql`octet_length(${t.prevHash}) = 32 and octet_length(${t.hash}) = 32`),
    check('ck_platform_audit_log_actor_kind', sql`${t.actorKind} in ('OPERATOR', 'SYSTEM')`),
  ],
);

export const platformAuditHead = pgTable(
  'platform_audit_head',
  {
    /** Linha única. */
    id: integer('id').notNull(),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull(),
    lastHash: bytea('last_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_platform_audit_head', columns: [t.id] }),
    check('ck_platform_audit_head_single', sql`${t.id} = 1`),
    check('ck_platform_audit_head_hash', sql`octet_length(${t.lastHash}) = 32`),
  ],
);
