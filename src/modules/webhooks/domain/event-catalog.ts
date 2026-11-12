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
  {
    type: 'certificate.expiring',
    description:
      'Certificado ativo perto do vencimento: avisos a 30, 15, 7 e 1 dia. `data.thresholdDays` é o limiar e `data.daysRemaining` os dias restantes. Envie o novo certificado antes do vencimento (a troca tem sobreposição).',
    subscribable: true,
  },
  {
    type: 'certificate.expired',
    description: 'O certificado ativo venceu: a emissão do estabelecimento falha antes do envio até um novo certificado ser validado.',
    subscribable: true,
  },
  {
    type: 'service_invoice.status_changed',
    description:
      'A NFS-e mudou de estado. `data.status`: AUTHORIZED (autorizada), REJECTED (rejeitada pelo autorizador, `data.rejectionCode`), FAILED (falha local antes de qualquer envio, `data.failureCode`), UNKNOWN (em verificação junto ao autorizador: NÃO reemita; o motor consulta e resolve) ou CANCELLED (cancelamento registrado, `data.cancellationId`).',
    subscribable: true,
  },
  {
    type: 'service_invoice.cancellation_changed',
    description:
      'O pedido de cancelamento mudou de estado. `data.status`: REGISTERED (cancelada), REJECTED (recusado pelo autorizador, `data.rejectionCode`; a nota continua autorizada), FAILED (falha local antes de qualquer envio, `data.failureCode`) ou UNKNOWN (em verificação: NÃO peça de novo; o motor consulta e resolve).',
    subscribable: true,
  },
  { type: 'webhook.test', description: 'Evento de teste disparado pelo endpoint de teste da assinatura.', subscribable: false },
];

export const SUBSCRIBABLE_EVENT_TYPES = EVENT_CATALOG.filter((e) => e.subscribable).map((e) => e.type);

export function isSubscribableEventType(value: string): value is IntegrationEventType {
  return (SUBSCRIBABLE_EVENT_TYPES as readonly string[]).includes(value);
}
