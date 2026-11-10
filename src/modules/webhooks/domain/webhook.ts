import type { IntegrationEventData, IntegrationEventType } from '../../../shared/domain/integration-events.js';

/** Limites por aplicação e empresa (evita abuso do worker-general). */
export const MAX_SUBSCRIPTIONS_PER_APPLICATION = 10;
export const MAX_DESCRIPTION_LENGTH = 200;

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Assinatura de webhook. Pertence a uma aplicação cliente dentro de uma empresa. */
export interface WebhookSubscription {
  readonly id: string;
  readonly companyId: string;
  readonly clientApplicationId: string;
  readonly url: string;
  readonly eventTypes: readonly IntegrationEventType[];
  readonly description: string | null;
  readonly status: SubscriptionStatus;
  /** Aumenta a cada rotação do segredo. */
  readonly secretVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Estados de uma entrega:
 * - PENDING: aguardando a 1ª tentativa;
 * - RETRYING: falhou, há nova tentativa agendada (calendário em retry-schedule.ts);
 * - SUCCEEDED: o destino respondeu 2xx;
 * - FAILED: tentativas esgotadas, assinatura desativada ou acesso à empresa revogado.
 */
export const DELIVERY_STATUSES = ['PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface WebhookDelivery {
  readonly id: string;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: IntegrationEventType;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastHttpStatus: number | null;
  readonly lastErrorCode: string | null;
  readonly deliveredAt: Date | null;
  /** Entrega original, quando esta é um reenvio manual. */
  readonly redeliveryOf: string | null;
  readonly createdAt: Date;
}

/** Evento como entregue ao cliente (corpo JSON do webhook). */
export interface WebhookEventBody {
  readonly id: string;
  readonly type: IntegrationEventType;
  readonly occurredAt: string;
  readonly companyId: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly data: IntegrationEventData;
}
