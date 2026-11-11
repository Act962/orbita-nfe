import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';
import type { IdGenerator, TransactionOptions, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import type { IntegrationEventType } from '../../../shared/domain/integration-events.js';
import { EVENT_CATALOG, isSubscribableEventType, type EventTypeDescription } from '../domain/event-catalog.js';
import { checkWebhookUrl } from '../domain/target-policy.js';
import { MAX_DESCRIPTION_LENGTH, MAX_SUBSCRIPTIONS_PER_APPLICATION, type DeliveryStatus, type SubscriptionStatus, type WebhookDelivery, type WebhookSubscription } from '../domain/webhook.js';
import type { SecretGenerator, SecretSealer, SubscriptionChanges, WebhookApiRepositories } from './ports.js';

const subscriptionNotFound = (): NotFoundError => new NotFoundError('WEBHOOK_SUBSCRIPTION_NOT_FOUND', 'Assinatura de webhook não encontrada.');
const deliveryNotFound = (): NotFoundError => new NotFoundError('WEBHOOK_DELIVERY_NOT_FOUND', 'Entrega de webhook não encontrada.');

export interface SubscriptionInput {
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly description?: string | null | undefined;
}

export interface SubscriptionUpdate {
  readonly url?: string | undefined;
  readonly eventTypes?: readonly string[] | undefined;
  readonly description?: string | null | undefined;
  readonly status?: SubscriptionStatus | undefined;
}

/** Assinatura recém-criada ou com segredo rotacionado: o segredo aparece só nesta resposta. */
export interface SubscriptionWithSecret {
  readonly subscription: WebhookSubscription;
  readonly secret: string;
}

/**
 * Casos de uso da API (papel fiscal_api). Cada aplicação cliente só vê e altera as próprias
 * assinaturas, na empresa do header (RLS + filtro pela aplicação). O segredo é cifrado com a
 * chave PÚBLICA da plataforma: a API não consegue decifrá-lo depois (ADR-0021).
 */
export class WebhookService {
  constructor(
    private readonly uow: UnitOfWork<WebhookApiRepositories>,
    private readonly sealer: SecretSealer,
    private readonly secrets: SecretGenerator,
    private readonly newId: IdGenerator,
    private readonly options: { allowPrivateTargets: boolean },
  ) {}

  catalog(): readonly EventTypeDescription[] {
    return EVENT_CATALOG;
  }

  private validate(input: { url?: string | undefined; eventTypes?: readonly string[] | undefined; description?: string | null | undefined }): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.url !== undefined) {
      const checked = checkWebhookUrl(input.url, { allowPrivateTargets: this.options.allowPrivateTargets });
      if (!checked.ok) issues.push({ code: checked.issue, field: 'url', message: 'URL de destino não permitida: use https para um endereço público, sem usuário/senha nem fragmento.' });
    }
    if (input.eventTypes !== undefined) {
      if (input.eventTypes.length === 0) issues.push({ code: 'REQUIRED', field: 'eventTypes', message: 'Informe ao menos um tipo de evento.' });
      if (new Set(input.eventTypes).size !== input.eventTypes.length) issues.push({ code: 'DUPLICATED', field: 'eventTypes', message: 'Tipos de evento repetidos.' });
      input.eventTypes.forEach((type, index) => {
        if (!isSubscribableEventType(type)) issues.push({ code: 'UNKNOWN_EVENT_TYPE', field: `eventTypes.${index}`, message: 'Tipo de evento fora do catálogo.' });
      });
    }
    if (input.description !== undefined && input.description !== null && input.description.length > MAX_DESCRIPTION_LENGTH) {
      issues.push({ code: 'TOO_LONG', field: 'description', message: `Até ${MAX_DESCRIPTION_LENGTH} caracteres.` });
    }
    return issues;
  }

  async create(
    companyId: string,
    input: SubscriptionInput,
    context: AuditContext & { clientApplicationId: string },
    options: TransactionOptions = {},
  ): Promise<SubscriptionWithSecret> {
    const issues = this.validate(input);
    if (issues.length > 0) throw new ValidationFailedError(issues);
    const id = this.newId();
    const secret = this.secrets.generate();
    const sealed = this.sealer.seal(secret, { companyId, subscriptionId: id, version: 1 });
    const subscription = await this.uow.inCompany(companyId, async (r) => {
      if ((await r.subscriptions.countByApplication(context.clientApplicationId)) >= MAX_SUBSCRIPTIONS_PER_APPLICATION) {
        throw new BusinessRuleError('WEBHOOK_SUBSCRIPTION_LIMIT', `Limite de ${MAX_SUBSCRIPTIONS_PER_APPLICATION} assinaturas por aplicação nesta empresa.`);
      }
      const created = await r.subscriptions.insert({
        id,
        clientApplicationId: context.clientApplicationId,
        url: input.url,
        eventTypes: input.eventTypes as IntegrationEventType[],
        description: input.description ?? null,
        sealed,
      });
      await r.audit.record(context, {
        action: 'webhook_subscription.created',
        subject: { type: 'webhook_subscription', id },
        // Só o host: a URL pode carregar token do cliente na query string.
        details: { host: new URL(input.url).host, eventTypes: [...created.eventTypes] },
      });
      return created;
    }, options);
    return { subscription, secret };
  }

  async list(companyId: string, clientApplicationId: string): Promise<WebhookSubscription[]> {
    return this.uow.inCompany(companyId, (r) => r.subscriptions.listByApplication(clientApplicationId));
  }

  async get(companyId: string, clientApplicationId: string, id: string): Promise<WebhookSubscription> {
    const found = await this.uow.inCompany(companyId, (r) => r.subscriptions.findForApplication(clientApplicationId, id));
    if (found === undefined) throw subscriptionNotFound();
    return found;
  }

  async update(companyId: string, id: string, input: SubscriptionUpdate, context: AuditContext & { clientApplicationId: string }): Promise<WebhookSubscription> {
    const issues = this.validate(input);
    if (issues.length > 0) throw new ValidationFailedError(issues);
    return this.uow.inCompany(companyId, async (r) => {
      const current = await r.subscriptions.findForApplication(context.clientApplicationId, id);
      if (current === undefined) throw subscriptionNotFound();
      const changes: SubscriptionChanges = {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes as IntegrationEventType[] } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
      const updated = await r.subscriptions.update(id, changes);
      await r.audit.record(context, {
        action: 'webhook_subscription.updated',
        subject: { type: 'webhook_subscription', id },
        details: { changedFields: Object.keys(changes), status: updated.status, host: new URL(updated.url).host },
      });
      return updated;
    });
  }

  /** Troca o segredo; o anterior deixa de valer imediatamente (entregas seguintes usam o novo). */
  async rotateSecret(companyId: string, id: string, context: AuditContext & { clientApplicationId: string }): Promise<SubscriptionWithSecret> {
    const secret = this.secrets.generate();
    const subscription = await this.uow.inCompany(companyId, async (r) => {
      const current = await r.subscriptions.findForApplication(context.clientApplicationId, id);
      if (current === undefined) throw subscriptionNotFound();
      const version = current.secretVersion + 1;
      const rotated = await r.subscriptions.rotateSecret(id, this.sealer.seal(secret, { companyId, subscriptionId: id, version }), version);
      await r.audit.record(context, { action: 'webhook_subscription.secret_rotated', subject: { type: 'webhook_subscription', id }, details: { version } });
      return rotated;
    });
    return { subscription, secret };
  }

  /** Dispara um evento `webhook.test` só para esta assinatura (ignora o filtro de tipos). */
  async sendTest(companyId: string, id: string, context: AuditContext & { clientApplicationId: string }): Promise<WebhookDelivery> {
    return this.uow.inCompany(companyId, async (r) => {
      const subscription = await r.subscriptions.findForApplication(context.clientApplicationId, id);
      if (subscription === undefined) throw subscriptionNotFound();
      if (subscription.status !== 'ACTIVE') throw new BusinessRuleError('WEBHOOK_SUBSCRIPTION_DISABLED', 'A assinatura está desativada.');
      const eventId = await r.events.publish({
        type: 'webhook.test',
        subject: { type: 'webhook_subscription', id },
        data: { subscriptionId: id },
        correlationId: context.correlationId,
      });
      return this.scheduleDelivery(r, companyId, { subscriptionId: id, eventId, redeliveryOf: null, correlationId: context.correlationId });
    });
  }

  async listDeliveries(
    companyId: string,
    clientApplicationId: string,
    filter: { subscriptionId?: string; eventId?: string; status?: DeliveryStatus; limit: number },
  ): Promise<WebhookDelivery[]> {
    return this.uow.inCompany(companyId, (r) => r.deliveries.listForApplication(clientApplicationId, filter));
  }

  async getDelivery(companyId: string, clientApplicationId: string, id: string): Promise<WebhookDelivery> {
    const found = await this.uow.inCompany(companyId, (r) => r.deliveries.findForApplication(clientApplicationId, id));
    if (found === undefined) throw deliveryNotFound();
    return found;
  }

  /** Reenvio manual: nova entrega do mesmo evento (mesmo `webhook-id`, o cliente deduplica). */
  async redeliver(companyId: string, deliveryId: string, context: AuditContext & { clientApplicationId: string }): Promise<WebhookDelivery> {
    return this.uow.inCompany(companyId, async (r) => {
      const original = await r.deliveries.findForApplication(context.clientApplicationId, deliveryId);
      if (original === undefined) throw deliveryNotFound();
      const subscription = await r.subscriptions.findForApplication(context.clientApplicationId, original.subscriptionId);
      if (subscription?.status !== 'ACTIVE') throw new BusinessRuleError('WEBHOOK_SUBSCRIPTION_DISABLED', 'A assinatura está desativada.');
      const delivery = await this.scheduleDelivery(r, companyId, {
        subscriptionId: original.subscriptionId,
        eventId: original.eventId,
        redeliveryOf: original.redeliveryOf ?? original.id,
        correlationId: context.correlationId,
      });
      await r.audit.record(context, {
        action: 'webhook_delivery.redelivered',
        subject: { type: 'webhook_delivery', id: delivery.id },
        details: { originalDeliveryId: original.id, eventId: original.eventId },
      });
      return delivery;
    });
  }

  private async scheduleDelivery(
    r: WebhookApiRepositories,
    companyId: string,
    input: { subscriptionId: string; eventId: string; redeliveryOf: string | null; correlationId: string | null },
  ): Promise<WebhookDelivery> {
    const delivery = await r.deliveries.insert({ id: this.newId(), subscriptionId: input.subscriptionId, eventId: input.eventId, redeliveryOf: input.redeliveryOf });
    await r.jobs.enqueue({
      queue: 'webhooks.deliver',
      payload: { companyId, deliveryId: delivery.id },
      singletonKey: `${delivery.id}:1`,
      correlationId: input.correlationId,
    });
    return delivery;
  }
}
