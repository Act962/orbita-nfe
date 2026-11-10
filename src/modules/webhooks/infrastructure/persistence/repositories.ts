import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { InternalError } from '../../../../shared/application/errors.js';
import { isIntegrationEventType, type IntegrationEventType } from '../../../../shared/domain/integration-events.js';
import type { Transaction } from '../../../../shared/infrastructure/database/database.js';
import { outboxEvents } from '../../../../shared/infrastructure/outbox/schema.js';
import type {
  DeliveryAttemptContext,
  DeliveryFilter,
  DeliveryRepository,
  DispatcherRepositories,
  StoredEvent,
  SubscriptionRepository,
} from '../../application/ports.js';
import type { DeliveryStatus, SubscriptionStatus, WebhookDelivery, WebhookSubscription } from '../../domain/webhook.js';
import { webhookDeliveries, webhookSubscriptions } from './schema.js';

const eventTypes = (values: readonly string[]): IntegrationEventType[] => {
  if (!values.every(isIntegrationEventType)) throw new InternalError('WEBHOOK_UNKNOWN_EVENT_TYPE_STORED');
  return values as IntegrationEventType[];
};

/** Colunas que a API pode ler (o segredo cifrado fica de fora: sem grant de SELECT). */
const subscriptionColumns = {
  id: webhookSubscriptions.id,
  companyId: webhookSubscriptions.companyId,
  clientApplicationId: webhookSubscriptions.clientApplicationId,
  url: webhookSubscriptions.url,
  eventTypes: webhookSubscriptions.eventTypes,
  description: webhookSubscriptions.description,
  status: webhookSubscriptions.status,
  secretVersion: webhookSubscriptions.secretVersion,
  createdAt: webhookSubscriptions.createdAt,
  updatedAt: webhookSubscriptions.updatedAt,
};

type SubscriptionRow = Pick<typeof webhookSubscriptions.$inferSelect, keyof typeof subscriptionColumns>;

const toSubscription = (row: SubscriptionRow): WebhookSubscription => ({
  ...row,
  eventTypes: eventTypes(row.eventTypes),
  status: row.status as SubscriptionStatus,
});

export function subscriptionRepository(tx: Transaction): SubscriptionRepository {
  const one = (rows: SubscriptionRow[]): WebhookSubscription => {
    const row = rows[0];
    if (row === undefined) throw new InternalError('WEBHOOK_SUBSCRIPTION_WRITE_LOST');
    return toSubscription(row);
  };
  return {
    async countByApplication(clientApplicationId) {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.clientApplicationId, clientApplicationId));
      return rows[0]?.n ?? 0;
    },
    async insert(s) {
      return one(
        await tx
          .insert(webhookSubscriptions)
          .values({
            id: s.id,
            companyId: sql`app_current_company()`,
            clientApplicationId: s.clientApplicationId,
            url: s.url,
            eventTypes: [...s.eventTypes],
            description: s.description,
            secretCiphertext: s.sealed.ciphertext,
            secretKekId: s.sealed.kekId,
          })
          .returning(subscriptionColumns),
      );
    },
    async listByApplication(clientApplicationId) {
      const rows = await tx
        .select(subscriptionColumns)
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.clientApplicationId, clientApplicationId))
        .orderBy(webhookSubscriptions.createdAt);
      return rows.map(toSubscription);
    },
    async findForApplication(clientApplicationId, id) {
      const rows = await tx
        .select(subscriptionColumns)
        .from(webhookSubscriptions)
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.clientApplicationId, clientApplicationId)));
      return rows[0] === undefined ? undefined : toSubscription(rows[0]);
    },
    async update(id, changes) {
      return one(
        await tx
          .update(webhookSubscriptions)
          .set({
            ...(changes.url !== undefined ? { url: changes.url } : {}),
            ...(changes.eventTypes !== undefined ? { eventTypes: [...changes.eventTypes] } : {}),
            ...(changes.description !== undefined ? { description: changes.description } : {}),
            ...(changes.status !== undefined ? { status: changes.status } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(webhookSubscriptions.id, id))
          .returning(subscriptionColumns),
      );
    },
    async rotateSecret(id, sealed, version) {
      return one(
        await tx
          .update(webhookSubscriptions)
          .set({ secretCiphertext: sealed.ciphertext, secretKekId: sealed.kekId, secretVersion: version, updatedAt: sql`now()` })
          .where(eq(webhookSubscriptions.id, id))
          .returning(subscriptionColumns),
      );
    },
  };
}

const deliveryColumns = {
  id: webhookDeliveries.id,
  subscriptionId: webhookDeliveries.subscriptionId,
  eventId: webhookDeliveries.eventId,
  eventType: outboxEvents.type,
  status: webhookDeliveries.status,
  attempts: webhookDeliveries.attempts,
  nextAttemptAt: webhookDeliveries.nextAttemptAt,
  lastAttemptAt: webhookDeliveries.lastAttemptAt,
  lastHttpStatus: webhookDeliveries.lastHttpStatus,
  lastErrorCode: webhookDeliveries.lastErrorCode,
  deliveredAt: webhookDeliveries.deliveredAt,
  redeliveryOf: webhookDeliveries.redeliveryOf,
  createdAt: webhookDeliveries.createdAt,
};

type DeliveryRow = Pick<typeof webhookDeliveries.$inferSelect, Exclude<keyof typeof deliveryColumns, 'eventType'>> & { eventType: string };

const toDelivery = (row: DeliveryRow): WebhookDelivery => {
  const [type] = eventTypes([row.eventType]);
  if (type === undefined) throw new InternalError('WEBHOOK_UNKNOWN_EVENT_TYPE_STORED');
  return { ...row, eventType: type, status: row.status as DeliveryStatus };
};

export function deliveryRepository(tx: Transaction): DeliveryRepository {
  const forApplication = (clientApplicationId: string) =>
    tx
      .select(deliveryColumns)
      .from(webhookDeliveries)
      .innerJoin(webhookSubscriptions, eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId))
      .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.eventId))
      .where(eq(webhookSubscriptions.clientApplicationId, clientApplicationId))
      .$dynamic();

  return {
    async listForApplication(clientApplicationId, filter: DeliveryFilter) {
      const conditions = [
        eq(webhookSubscriptions.clientApplicationId, clientApplicationId),
        ...(filter.subscriptionId !== undefined ? [eq(webhookDeliveries.subscriptionId, filter.subscriptionId)] : []),
        ...(filter.eventId !== undefined ? [eq(webhookDeliveries.eventId, filter.eventId)] : []),
        ...(filter.status !== undefined ? [eq(webhookDeliveries.status, filter.status)] : []),
      ];
      const rows = await forApplication(clientApplicationId)
        .where(and(...conditions))
        .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
        .limit(filter.limit);
      return rows.map(toDelivery);
    },
    async findForApplication(clientApplicationId, id) {
      const rows = await forApplication(clientApplicationId).where(
        and(eq(webhookSubscriptions.clientApplicationId, clientApplicationId), eq(webhookDeliveries.id, id)),
      );
      return rows[0] === undefined ? undefined : toDelivery(rows[0]);
    },
    async insert(input) {
      await tx.insert(webhookDeliveries).values({
        id: input.id,
        companyId: sql`app_current_company()`,
        subscriptionId: input.subscriptionId,
        eventId: input.eventId,
        redeliveryOf: input.redeliveryOf,
        nextAttemptAt: sql`now()`,
      });
      const rows = await tx
        .select(deliveryColumns)
        .from(webhookDeliveries)
        .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.eventId))
        .where(eq(webhookDeliveries.id, input.id));
      if (rows[0] === undefined) throw new InternalError('WEBHOOK_DELIVERY_WRITE_LOST');
      return toDelivery(rows[0]);
    },
  };
}

interface AttemptRow extends Record<string, unknown> {
  delivery_status: string;
  attempts: number;
  subscription_id: string;
  url: string;
  subscription_status: string;
  secret_ciphertext: Buffer;
  secret_kek_id: string;
  secret_version: number;
  access_active: boolean;
}

/** Repositórios do worker-general (papel fiscal_general), sempre no contexto da empresa. */
export function dispatcherRepositories(tx: Transaction): Omit<DispatcherRepositories, 'jobs'> {
  const findEvent = async (id: string): Promise<StoredEvent | undefined> => {
    const rows = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    const row = rows[0];
    if (row === undefined) return undefined;
    if (!isIntegrationEventType(row.type)) throw new InternalError('OUTBOX_UNKNOWN_EVENT_TYPE_STORED');
    return {
      id: row.id,
      companyId: row.companyId,
      type: row.type,
      subject: { type: row.subjectType, id: row.subjectId },
      data: row.data,
      occurredAt: row.occurredAt,
      correlationId: row.correlationId,
    };
  };

  return {
    events: { findById: findEvent },
    subscriptions: {
      async findMatching(type, occurredAt) {
        // A aplicação dona precisa estar ativa e com concessão ativa para a empresa.
        const result = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
          select s.id from webhook_subscriptions s
            join company_grants g on g.company_id = s.company_id and g.client_application_id = s.client_application_id and g.status = 'ACTIVE'
            join client_applications a on a.id = s.client_application_id and a.status = 'ACTIVE'
           where s.status = 'ACTIVE' and ${type} = any(s.event_types) and s.created_at <= ${occurredAt}
           order by s.id`);
        return result.rows.map((r) => r.id);
      },
    },
    deliveries: {
      async insertOriginal(input) {
        const result = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
          insert into webhook_deliveries (id, company_id, subscription_id, event_id, next_attempt_at)
          values (${input.id}, app_current_company(), ${input.subscriptionId}, ${input.eventId}, now())
          on conflict (subscription_id, event_id) where redelivery_of is null do nothing
          returning id`);
        return result.rows[0]?.id;
      },
      async lockForAttempt(deliveryId): Promise<DeliveryAttemptContext | undefined> {
        const locked = await tx.execute<AttemptRow>(sql`
          select d.status as delivery_status, d.attempts, s.id as subscription_id, s.url, s.status as subscription_status,
                 s.secret_ciphertext, s.secret_kek_id, s.secret_version,
                 exists (select 1 from company_grants g join client_applications a on a.id = g.client_application_id
                          where g.company_id = s.company_id and g.client_application_id = s.client_application_id
                            and g.status = 'ACTIVE' and a.status = 'ACTIVE') as access_active
            from webhook_deliveries d join webhook_subscriptions s on s.id = d.subscription_id
           where d.id = ${deliveryId}
             for update of d`);
        const row = locked.rows[0];
        if (row === undefined) return undefined;
        const deliveryRows = await tx
          .select(deliveryColumns)
          .from(webhookDeliveries)
          .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.eventId))
          .where(eq(webhookDeliveries.id, deliveryId));
        const delivery = deliveryRows[0];
        if (delivery === undefined) return undefined;
        const event = await findEvent(delivery.eventId);
        if (event === undefined) throw new InternalError('WEBHOOK_DELIVERY_WITHOUT_EVENT');
        return {
          delivery: toDelivery(delivery),
          event,
          subscription: {
            id: row.subscription_id,
            url: row.url,
            status: row.subscription_status as SubscriptionStatus,
            secretVersion: row.secret_version,
            sealed: { ciphertext: row.secret_ciphertext, kekId: row.secret_kek_id },
          },
          accessActive: row.access_active,
        };
      },
      async recordSuccess(deliveryId, httpStatus) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: 'SUCCEEDED',
            attempts: sql`${webhookDeliveries.attempts} + 1`,
            lastAttemptAt: sql`now()`,
            deliveredAt: sql`now()`,
            nextAttemptAt: null,
            lastHttpStatus: httpStatus,
            lastErrorCode: null,
            updatedAt: sql`now()`,
          })
          .where(eq(webhookDeliveries.id, deliveryId));
      },
      async recordFailure(deliveryId, failure) {
        const attempted = failure.code !== 'SUBSCRIPTION_DISABLED' && failure.code !== 'COMPANY_ACCESS_REVOKED';
        await tx
          .update(webhookDeliveries)
          .set({
            status: failure.nextAttemptAt === null ? 'FAILED' : 'RETRYING',
            ...(attempted ? { attempts: sql`${webhookDeliveries.attempts} + 1`, lastAttemptAt: sql`now()` } : {}),
            nextAttemptAt: failure.nextAttemptAt,
            lastHttpStatus: failure.httpStatus,
            lastErrorCode: failure.code.slice(0, 64),
            updatedAt: sql`now()`,
          })
          .where(and(eq(webhookDeliveries.id, deliveryId), isNull(webhookDeliveries.deliveredAt)));
      },
    },
  };
}
