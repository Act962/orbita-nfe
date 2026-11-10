import type { IntegrationEventType } from '../../../shared/domain/integration-events.js';

/**
 * Catálogo público de eventos de webhook (ADR-0027 B6). Uma assinatura escolhe quais tipos
 * quer receber. `webhook.test` não é assinável: só é entregue pelo endpoint de teste.
 */
export interface EventTypeDescription {
  readonly type: IntegrationEventType;
  readonly description: string;
  readonly subscribable: boolean;
}

export const EVENT_CATALOG: readonly EventTypeDescription[] = [
  {
    type: 'certificate.activated',
    description: 'Certificado A1 validado pelo worker fiscal e ativo para o estabelecimento (o anterior, se houver, foi substituído).',
    subscribable: true,
  },
  { type: 'certificate.rejected', description: 'Certificado A1 recusado na validação (regra CERT-001). `data.reason` traz o motivo.', subscribable: true },
  { type: 'certificate.revoked', description: 'Certificado revogado pela aplicação; a chave do envelope foi destruída.', subscribable: true },
  { type: 'webhook.test', description: 'Evento de teste disparado pelo endpoint de teste da assinatura.', subscribable: false },
];

export const SUBSCRIBABLE_EVENT_TYPES = EVENT_CATALOG.filter((e) => e.subscribable).map((e) => e.type);

export function isSubscribableEventType(value: string): value is IntegrationEventType {
  return (SUBSCRIBABLE_EVENT_TYPES as readonly string[]).includes(value);
}
