import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Fila própria (ADR-0030). Sem company_id: o conteúdo é só de identificadores e quem consome
 * atende todas as empresas (o handler abre a transação da empresa, onde vale o RLS dos dados).
 *
 * Na migration de segurança: RLS por lane (worker-fiscal só vê `fiscal`, worker-general só
 * `general`), a API só insere, o operador inspeciona e reprocessa, nenhuma aplicação apaga
 * job que não esteja concluído ou descartado.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull(),
    lane: text('lane').notNull(),
    payload: jsonb('payload').$type<Record<string, string>>().notNull(),
    singletonKey: text('singleton_key'),
    state: text('state').notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lockedBy: text('locked_by'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastError: text('last_error'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check('ck_jobs_state', sql`${t.state} in ('queued', 'active', 'completed', 'dead', 'discarded')`),
    check('ck_jobs_lane', sql`${t.lane} in ('fiscal', 'general')`),
    check('ck_jobs_attempts', sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    check('ck_jobs_last_error', sql`${t.lastError} is null or length(${t.lastError}) <= 200`),
    // No máximo um job pendente ou em execução por (fila, chave).
    uniqueIndex('uq_jobs_singleton')
      .on(t.queue, t.singletonKey)
      .where(sql`${t.singletonKey} is not null and ${t.state} in ('queued', 'active')`),
    index('ix_jobs_ready').on(t.lane, t.priority, t.runAt).where(sql`${t.state} = 'queued'`),
    index('ix_jobs_lease').on(t.lane, t.leaseUntil).where(sql`${t.state} = 'active'`),
    index('ix_jobs_finished').on(t.finishedAt).where(sql`${t.state} in ('completed', 'discarded')`),
  ],
);

/** Pausa por fila (operação manual auditada). Pausar não muda nenhum job nem documento. */
export const queueControls = pgTable('queue_controls', {
  queue: text('queue').primaryKey(),
  paused: boolean('paused').notNull(),
  reason: text('reason'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
