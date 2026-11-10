/**
 * Fachada pública do módulo de webhooks (ADR-0015, ADR-0027 B6).
 *
 * A API usa `WebhookService` + `RsaSecretSealer` (chave PÚBLICA). O worker-general usa
 * `WebhookDispatcher` + `RsaSecretOpener` (chave privada) + `HttpWebhookSender`.
 */
export { WebhookService } from './application/webhook-service.js';
export { WebhookDispatcher, eventBody, type AttemptOutcome } from './application/webhook-dispatcher.js';
export { EVENT_CATALOG, SUBSCRIBABLE_EVENT_TYPES } from './domain/event-catalog.js';
export { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS, nextRetryDelaySeconds } from './domain/retry-schedule.js';
export { checkWebhookUrl, isPublicIpAddress } from './domain/target-policy.js';
export { RsaSecretOpener, RsaSecretSealer, randomSecretGenerator, standardWebhookSigner, webhookKekIdOf, SECRET_PREFIX } from './infrastructure/crypto/webhook-crypto.js';
export { HttpWebhookSender } from './infrastructure/http/webhook-sender.js';
export { webhookApiUnitOfWork, webhookDispatcherUnitOfWork } from './infrastructure/persistence/unit-of-work.js';
export { registerWebhookRoutes } from './presentation/http/routes.js';
