/**
 * Catálogo fechado de eventos de integração (outbox → webhooks). Tipo novo entra aqui, no
 * catálogo público de webhooks (modules/webhooks/domain/event-catalog.ts) e no doc 11.
 */
export const INTEGRATION_EVENT_TYPES = [
  'certificate.activated',
  'certificate.rejected',
  'certificate.revoked',
  'certificate.expiring',
  'certificate.expired',
  /** Mudança visível de estado da NFS-e: AUTHORIZED, REJECTED, FAILED ou UNKNOWN ("em verificação, não reemita"). */
  'service_invoice.status_changed',
  /** Evento de teste disparado pelo cliente para conferir a assinatura de webhook. */
  'webhook.test',
] as const;
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

export function isIntegrationEventType(value: string): value is IntegrationEventType {
  return (INTEGRATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Dados do evento: mínimos, só identificadores e status (ADR-0015). Nunca XML, dados pessoais
 * ou segredos. Valores escalares, para o payload ser estável.
 */
export type IntegrationEventData = Readonly<Record<string, string | number | boolean | null>>;
