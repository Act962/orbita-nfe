import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bytea } from '../../../../shared/infrastructure/database/columns.js';

/**
 * Assinaturas de webhook (ADR-0015, ADR-0027 B6). O segredo fica cifrado com a chave pública
 * da plataforma (RSA-OAEP); a API grava mas não lê `secret_ciphertext` (grant por coluna na
 * migration de segurança); só o worker-general lê e decifra.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    clientApplicationId: uuid('client_application_id').notNull(),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull(),
    description: text('description'),
    status: text('status').notNull().default('ACTIVE'),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretKekId: text('secret_kek_id').notNull(),
    secretVersion: integer('secret_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_webhook_subscriptions_status', sql`${t.status} in ('ACTIVE', 'DISABLED')`),
    check('ck_webhook_subscriptions_event_types', sql`cardinality(${t.eventTypes}) between 1 and 20`),
    check('ck_webhook_subscriptions_url', sql`length(${t.url}) <= 2048`),
    check('ck_webhook_subscriptions_secret_version', sql`${t.secretVersion} >= 1`),
    // Alvo da FK composta das entregas: a entrega só referencia assinatura da MESMA empresa.
    unique('uq_webhook_subscriptions_company_id').on(t.companyId, t.id),
    index('ix_webhook_subscriptions_application').on(t.companyId, t.clientApplicationId),
  ],
);

/** Uma linha por (assinatura, evento) + reenvios manuais. Tentativas agregadas na própria linha. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastHttpStatus: integer('last_http_status'),
    lastErrorCode: text('last_error_code'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    redeliveryOf: uuid('redelivery_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_webhook_deliveries_status', sql`${t.status} in ('PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED')`),
    check('ck_webhook_deliveries_attempts', sql`${t.attempts} >= 0`),
    check('ck_webhook_deliveries_error', sql`${t.lastErrorCode} is null or length(${t.lastErrorCode}) <= 64`),
    // O fanout é idempotente: no máximo uma entrega ORIGINAL por (assinatura, evento).
    uniqueIndex('uq_webhook_deliveries_original').on(t.subscriptionId, t.eventId).where(sql`${t.redeliveryOf} is null`),
    index('ix_webhook_deliveries_subscription').on(t.companyId, t.subscriptionId, t.createdAt),
    index('ix_webhook_deliveries_event').on(t.companyId, t.eventId),
  ],
);
