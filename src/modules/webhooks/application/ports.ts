import type { AuditTrail } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../shared/application/outbox.js';
import type { IntegrationEventData, IntegrationEventType } from '../../../shared/domain/integration-events.js';
import type { DeliveryStatus, SubscriptionStatus, WebhookDelivery, WebhookSubscription } from '../domain/webhook.js';

/** Segredo de assinatura cifrado com a chave pública da plataforma (só o worker-general decifra). */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly kekId: string;
}

/** Amarra o segredo cifrado à assinatura e à versão: trocar de linha no banco não funciona. */
export interface SecretBinding {
  readonly companyId: string;
  readonly subscriptionId: string;
  readonly version: number;
}

export interface SecretSealer {
  seal(secret: string, binding: SecretBinding): SealedSecret;
}

export interface SecretOpener {
  open(sealed: SealedSecret, binding: SecretBinding): string;
}

/** Gera o segredo exibido UMA vez ao cliente (`whsec_` + 32 bytes aleatórios em base64). */
export interface SecretGenerator {
  generate(): string;
}

export interface NewSubscription {
  readonly id: string;
  readonly clientApplicationId: string;
  readonly url: string;
  readonly eventTypes: readonly IntegrationEventType[];
  readonly description: string | null;
  readonly sealed: SealedSecret;
}

export interface SubscriptionChanges {
  readonly url?: string;
  readonly eventTypes?: readonly IntegrationEventType[];
  readonly description?: string | null;
  readonly status?: SubscriptionStatus;
}

/** Visão da API: sempre filtrada pela aplicação dona (e pela empresa, via RLS). */
export interface SubscriptionRepository {
  countByApplication(clientApplicationId: string): Promise<number>;
  insert(subscription: NewSubscription): Promise<WebhookSubscription>;
  listByApplication(clientApplicationId: string): Promise<WebhookSubscription[]>;
  findForApplication(clientApplicationId: string, id: string): Promise<WebhookSubscription | undefined>;
  update(id: string, changes: SubscriptionChanges): Promise<WebhookSubscription>;
  rotateSecret(id: string, sealed: SealedSecret, version: number): Promise<WebhookSubscription>;
}

export interface DeliveryFilter {
  readonly subscriptionId?: string;
  readonly eventId?: string;
  readonly status?: DeliveryStatus;
  readonly limit: number;
}

export interface DeliveryRepository {
  listForApplication(clientApplicationId: string, filter: DeliveryFilter): Promise<WebhookDelivery[]>;
  findForApplication(clientApplicationId: string, id: string): Promise<WebhookDelivery | undefined>;
  /** Nova entrega do mesmo evento para a mesma assinatura (reenvio manual ou teste). */
  insert(input: { id: string; subscriptionId: string; eventId: string; redeliveryOf: string | null }): Promise<WebhookDelivery>;
}

export interface WebhookApiRepositories {
  readonly subscriptions: SubscriptionRepository;
  readonly deliveries: DeliveryRepository;
  readonly events: EventOutbox;
  readonly jobs: JobScheduler;
  readonly audit: AuditTrail;
}

// ----- worker-general -----

export interface StoredEvent {
  readonly id: string;
  readonly companyId: string;
  readonly type: IntegrationEventType;
  readonly subject: { readonly type: string; readonly id: string };
  readonly data: IntegrationEventData;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
}

/** Tudo o que uma tentativa de entrega precisa, lido com a entrega travada (FOR UPDATE). */
export interface DeliveryAttemptContext {
  readonly delivery: WebhookDelivery;
  readonly event: StoredEvent;
  readonly subscription: {
    readonly id: string;
    readonly url: string;
    readonly status: SubscriptionStatus;
    readonly secretVersion: number;
    readonly sealed: SealedSecret;
  };
  /** A aplicação dona ainda está ativa e com concessão ativa para a empresa? */
  readonly accessActive: boolean;
}

export interface DispatcherRepositories {
  readonly events: { findById(id: string): Promise<StoredEvent | undefined> };
  readonly subscriptions: {
    /**
     * Assinaturas ACTIVE que pedem o tipo, de aplicações ativas com concessão ativa, e que já
     * existiam quando o evento ocorreu (assinatura nova não recebe evento antigo).
     */
    findMatching(type: IntegrationEventType, occurredAt: Date): Promise<string[]>;
  };
  readonly deliveries: {
    /** Cria a entrega original da assinatura para o evento; `undefined` se já existia (fanout repetido). */
    insertOriginal(input: { id: string; subscriptionId: string; eventId: string }): Promise<string | undefined>;
    lockForAttempt(deliveryId: string): Promise<DeliveryAttemptContext | undefined>;
    recordSuccess(deliveryId: string, httpStatus: number): Promise<void>;
    recordFailure(deliveryId: string, failure: { httpStatus: number | null; code: string; nextAttemptAt: Date | null }): Promise<void>;
  };
  readonly jobs: JobScheduler;
}

export type SendResult =
  | { readonly kind: 'DELIVERED'; readonly httpStatus: number }
  | { readonly kind: 'HTTP_ERROR'; readonly httpStatus: number }
  | { readonly kind: 'NETWORK_ERROR'; readonly code: string };

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Cliente HTTP com proteção contra SSRF e sem seguir redirecionamentos. */
export interface WebhookSender {
  send(request: WebhookRequest, signal: AbortSignal): Promise<SendResult>;
}

/** Assinatura no formato Standard Webhooks (`v1,<base64 HMAC-SHA256>`). */
export interface WebhookSigner {
  sign(secret: string, webhookId: string, timestampSeconds: number, body: string): string;
}
