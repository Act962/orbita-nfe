import type { IntegrationEventData, IntegrationEventType } from '../domain/integration-events.js';

export { INTEGRATION_EVENT_TYPES, isIntegrationEventType, type IntegrationEventData, type IntegrationEventType } from '../domain/integration-events.js';

/**
 * Outbox transacional (docs/architecture/07 §4, ADR-0015). O evento é gravado na MESMA
 * transação da mudança que o originou, junto com o job que o distribui aos webhooks.
 */
export interface IntegrationEvent {
  readonly type: IntegrationEventType;
  readonly subject: { readonly type: string; readonly id: string };
  readonly data: IntegrationEventData;
  readonly correlationId: string | null;
}

/** Publica na transação corrente da empresa. Devolve o id do evento (é o `webhook-id`). */
export interface EventOutbox {
  publish(event: IntegrationEvent): Promise<string>;
}
