import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { nextRetryDelaySeconds } from '../domain/retry-schedule.js';
import type { WebhookEventBody } from '../domain/webhook.js';
import type { DeliveryAttemptContext, DispatcherRepositories, SecretOpener, WebhookSender, WebhookSigner } from './ports.js';

export type AttemptOutcome = 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'FAILED' | 'SKIPPED';

/** Corpo JSON entregue ao cliente. Estável: as chaves seguem sempre a mesma ordem. */
export function eventBody(event: DeliveryAttemptContext['event']): WebhookEventBody {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    companyId: event.companyId,
    subject: { type: event.subject.type, id: event.subject.id },
    data: event.data,
  };
}

/**
 * Casos de uso do worker-general (papel fiscal_general): distribui eventos do outbox às
 * assinaturas e faz as entregas HTTP assinadas. É o único processo que decifra os segredos de
 * webhook, e nunca tem material de certificados (ADR-0021).
 */
export class WebhookDispatcher {
  constructor(
    private readonly uow: UnitOfWork<DispatcherRepositories>,
    private readonly opener: SecretOpener,
    private readonly signer: WebhookSigner,
    private readonly sender: WebhookSender,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Cria uma entrega por assinatura interessada. Idempotente: rodar de novo não duplica. */
  async fanout(companyId: string, eventId: string): Promise<number> {
    return this.uow.inCompany(companyId, async (r) => {
      const event = await r.events.findById(eventId);
      if (event === undefined) return 0;
      let created = 0;
      for (const subscriptionId of await r.subscriptions.findMatching(event.type, event.occurredAt)) {
        const deliveryId = await r.deliveries.insertOriginal({ id: this.newId(), subscriptionId, eventId });
        if (deliveryId === undefined) continue;
        await r.jobs.enqueue({ queue: 'webhooks.deliver', payload: { companyId, deliveryId }, singletonKey: `${deliveryId}:1`, correlationId: event.correlationId });
        created++;
      }
      return created;
    });
  }

  /**
   * Uma tentativa de entrega. A transação NÃO fica aberta durante a chamada HTTP: lê e confere
   * (1), envia (2) e registra o resultado (3). Se o processo cair entre 2 e 3, o job é refeito
   * e o cliente pode receber de novo o mesmo `webhook-id` (entrega pelo menos uma vez).
   */
  async attempt(companyId: string, deliveryId: string, signal: AbortSignal): Promise<AttemptOutcome> {
    const context = await this.uow.inCompany(companyId, async (r) => {
      const found = await r.deliveries.lockForAttempt(deliveryId);
      if (found === undefined || found.delivery.status === 'SUCCEEDED' || found.delivery.status === 'FAILED') return undefined;
      if (found.subscription.status !== 'ACTIVE' || !found.accessActive) {
        await r.deliveries.recordFailure(deliveryId, {
          httpStatus: null,
          code: found.accessActive ? 'SUBSCRIPTION_DISABLED' : 'COMPANY_ACCESS_REVOKED',
          nextAttemptAt: null,
        });
        return 'FAILED' as const;
      }
      return found;
    });
    if (context === undefined) return 'SKIPPED';
    if (context === 'FAILED') return 'FAILED';

    const secret = this.opener.open(context.subscription.sealed, { companyId, subscriptionId: context.subscription.id, version: context.subscription.secretVersion });
    const body = JSON.stringify(eventBody(context.event));
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const result = await this.sender.send(
      {
        url: context.subscription.url,
        body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'orbita-nfe-webhooks/1',
          'webhook-id': context.event.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': this.signer.sign(secret, context.event.id, timestamp, body),
        },
      },
      signal,
    );

    return this.uow.inCompany(companyId, async (r) => {
      if (result.kind === 'DELIVERED') {
        await r.deliveries.recordSuccess(deliveryId, result.httpStatus);
        return 'SUCCEEDED';
      }
      const attemptsMade = context.delivery.attempts + 1;
      const delay = nextRetryDelaySeconds(attemptsMade);
      const nextAttemptAt = delay === null ? null : new Date(this.now().getTime() + delay * 1000);
      await r.deliveries.recordFailure(deliveryId, {
        httpStatus: result.kind === 'HTTP_ERROR' ? result.httpStatus : null,
        code: result.kind === 'HTTP_ERROR' ? 'HTTP_STATUS' : result.code,
        nextAttemptAt,
      });
      if (nextAttemptAt === null) return 'FAILED';
      await r.jobs.enqueue({
        queue: 'webhooks.deliver',
        payload: { companyId, deliveryId },
        singletonKey: `${deliveryId}:${attemptsMade + 1}`,
        runAt: nextAttemptAt,
        correlationId: context.event.correlationId,
      });
      return 'RETRY_SCHEDULED';
    });
  }
}
