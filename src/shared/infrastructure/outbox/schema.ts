import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Eventos de integração (outbox). Append-only para a aplicação (só INSERT e SELECT), RLS por
 * empresa. O `id` é o `Webhook-Id` de todas as entregas do evento (o cliente deduplica por ele).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    type: text('type').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    data: jsonb('data').$type<Record<string, string | number | boolean | null>>().notNull(),
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [index('ix_outbox_events_subject').on(t.companyId, t.subjectType, t.subjectId)],
);
