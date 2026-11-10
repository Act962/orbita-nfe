import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, callerOf, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { FastifyRequest } from 'fastify';
import type { WebhookService } from '../../application/webhook-service.js';
import { SUBSCRIBABLE_EVENT_TYPES } from '../../domain/event-catalog.js';
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS } from '../../domain/retry-schedule.js';
import { MAX_URL_LENGTH } from '../../domain/target-policy.js';
import { DELIVERY_STATUSES, MAX_DESCRIPTION_LENGTH, SUBSCRIPTION_STATUSES, type WebhookDelivery, type WebhookSubscription } from '../../domain/webhook.js';

const TAG = 'Webhooks';

const RETRY_POLICY =
  `Tentativa 1 imediata; depois de cada falha, novas tentativas após ${RETRY_DELAYS_SECONDS.map((s) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`)).join(', ')} ` +
  `(${MAX_DELIVERY_ATTEMPTS} tentativas em cerca de 22 h). Sucesso = resposta 2xx em até 10 s; redirecionamentos não são seguidos.`;

const SIGNATURE_DOC =
  'Cada entrega traz os headers `webhook-id` (id do evento, igual em todas as tentativas e reenvios: deduplique por ele), ' +
  '`webhook-timestamp` (segundos Unix) e `webhook-signature` = `v1,<base64(HMAC-SHA256(segredo, "<webhook-id>.<webhook-timestamp>.<corpo>"))>`, ' +
  'onde a chave HMAC são os bytes do base64 após `whsec_` (padrão Standard Webhooks). Recuse timestamps com mais de 5 minutos de diferença.';

const SubscriptionResponse = z
  .object({
    id: z.uuid(),
    url: z.string(),
    eventTypes: z.array(z.string()),
    description: z.string().nullable(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    secretVersion: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookSubscription' });

const SubscriptionWithSecretResponse = SubscriptionResponse.extend({
  secret: z.string().meta({ description: 'Segredo de assinatura (`whsec_...`). Exibido SOMENTE nesta resposta: guarde-o com segurança.' }),
}).meta({ id: 'WebhookSubscriptionWithSecret' });

const DeliveryResponse = z
  .object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    eventId: z.uuid().meta({ description: 'Igual ao header `webhook-id`.' }),
    eventType: z.string(),
    status: z.enum(DELIVERY_STATUSES),
    attempts: z.number().int(),
    nextAttemptAt: z.iso.datetime().nullable(),
    lastAttemptAt: z.iso.datetime().nullable(),
    lastHttpStatus: z.number().int().nullable(),
    lastErrorCode: z.string().nullable().meta({ description: 'HTTP_STATUS, TIMEOUT, CONNECTION_FAILED, TLS_ERROR, DNS_ERROR, TARGET_FORBIDDEN, SUBSCRIPTION_DISABLED, COMPANY_ACCESS_REVOKED.' }),
    deliveredAt: z.iso.datetime().nullable(),
    redeliveryOf: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WebhookDelivery' });

const eventTypesField = z
  .array(z.string())
  .min(1)
  .max(20)
  .meta({ description: `Tipos de evento desejados: ${SUBSCRIBABLE_EVENT_TYPES.join(', ')}. Catálogo em GET /v1/webhook-event-types.` });

const CreateBody = z
  .object({
    url: z.string().max(MAX_URL_LENGTH).meta({ description: 'Destino HTTPS público. Sem usuário/senha nem fragmento.' }),
    eventTypes: eventTypesField,
    description: z.string().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
  })
  .meta({ id: 'CreateWebhookSubscription' });

const UpdateBody = z
  .object({
    url: z.string().max(MAX_URL_LENGTH).optional(),
    eventTypes: eventTypesField.optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
    status: z.enum(SUBSCRIPTION_STATUSES).optional().meta({ description: 'DISABLED para de entregar (entregas pendentes falham com SUBSCRIPTION_DISABLED).' }),
  })
  .meta({ id: 'UpdateWebhookSubscription' });

const IdParams = z.object({ subscriptionId: z.uuid() });
const DeliveryParams = z.object({ deliveryId: z.uuid() });
const DeliveryQuery = z.object({
  subscriptionId: z.uuid().optional(),
  eventId: z.uuid().optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const subscriptionJson = (s: WebhookSubscription): z.infer<typeof SubscriptionResponse> => ({
  id: s.id,
  url: s.url,
  eventTypes: [...s.eventTypes],
  description: s.description,
  status: s.status,
  secretVersion: s.secretVersion,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

const deliveryJson = (d: WebhookDelivery): z.infer<typeof DeliveryResponse> => ({
  id: d.id,
  subscriptionId: d.subscriptionId,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  nextAttemptAt: iso(d.nextAttemptAt),
  lastAttemptAt: iso(d.lastAttemptAt),
  lastHttpStatus: d.lastHttpStatus,
  lastErrorCode: d.lastErrorCode,
  deliveredAt: iso(d.deliveredAt),
  redeliveryOf: d.redeliveryOf,
  createdAt: d.createdAt.toISOString(),
});

const ownerContext = (request: FastifyRequest) => ({ ...auditContextOf(request), clientApplicationId: callerOf(request).clientApplicationId });

const subscriptionNotFound = { 404: ProblemSchema.describe('WEBHOOK_SUBSCRIPTION_NOT_FOUND (inexistente, de outra empresa ou de outra aplicação).') };
const deliveryNotFound = { 404: ProblemSchema.describe('WEBHOOK_DELIVERY_NOT_FOUND') };

export function registerWebhookRoutes(app: HttpApp, service: WebhookService): void {
  app.get(
    '/v1/webhook-event-types',
    {
      config: { auth: { scope: 'webhooks:read', company: false } },
      schema: {
        tags: [TAG],
        summary: 'Catálogo de eventos',
        description: `Tipos de evento disponíveis para assinatura. ${RETRY_POLICY}`,
        security: [{ apiKey: [] }],
        response: {
          200: z.object({
            items: z.array(z.object({ type: z.string(), description: z.string(), subscribable: z.boolean() })),
            retryScheduleSeconds: z.array(z.number().int()).meta({ description: 'Espera antes de cada nova tentativa, após a 1ª.' }),
          }),
          ...commonErrorResponses,
          ...authErrorResponses,
        },
      },
    },
    () => Promise.resolve({ items: service.catalog().map((e) => ({ ...e })), retryScheduleSeconds: [...RETRY_DELAYS_SECONDS] }),
  );

  app.post(
    '/v1/webhook-subscriptions',
    {
      config: { auth: { scope: 'webhooks:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Criar assinatura de webhook',
        description: `A assinatura pertence à aplicação que a cria, na empresa do header. ${SIGNATURE_DOC}`,
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        body: CreateBody,
        response: { 201: SubscriptionWithSecretResponse, ...commonErrorResponses, ...authErrorResponses, 422: ProblemSchema.describe('WEBHOOK_SUBSCRIPTION_LIMIT') },
      },
    },
    async (request, reply) => {
      const created = await withIssueFields('body', () => service.create(companyIdOf(request), request.body, ownerContext(request)));
      return reply
        .status(201)
        .header('location', `/v1/webhook-subscriptions/${created.subscription.id}`)
        .send({ ...subscriptionJson(created.subscription), secret: created.secret });
    },
  );

  app.get(
    '/v1/webhook-subscriptions',
    {
      config: { auth: { scope: 'webhooks:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Listar assinaturas da aplicação',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        response: { 200: z.object({ items: z.array(SubscriptionResponse) }), ...commonErrorResponses, ...authErrorResponses },
      },
    },
    async (request) => ({ items: (await service.list(companyIdOf(request), callerOf(request).clientApplicationId)).map(subscriptionJson) }),
  );

  app.get(
    '/v1/webhook-subscriptions/:subscriptionId',
    {
      config: { auth: { scope: 'webhooks:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar assinatura',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: IdParams,
        response: { 200: SubscriptionResponse, ...commonErrorResponses, ...authErrorResponses, ...subscriptionNotFound },
      },
    },
    async (request) => subscriptionJson(await service.get(companyIdOf(request), callerOf(request).clientApplicationId, request.params.subscriptionId)),
  );

  app.patch(
    '/v1/webhook-subscriptions/:subscriptionId',
    {
      config: { auth: { scope: 'webhooks:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Alterar assinatura',
        description: 'Altera URL, tipos de evento, descrição ou status. Para remover, desative (status DISABLED).',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: IdParams,
        body: UpdateBody,
        response: { 200: SubscriptionResponse, ...commonErrorResponses, ...authErrorResponses, ...subscriptionNotFound },
      },
    },
    async (request) =>
      subscriptionJson(await withIssueFields('body', () => service.update(companyIdOf(request), request.params.subscriptionId, request.body, ownerContext(request)))),
  );

  app.post(
    '/v1/webhook-subscriptions/:subscriptionId/secret-rotation',
    {
      config: { auth: { scope: 'webhooks:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Rotacionar segredo',
        description: 'Gera um novo segredo e invalida o anterior imediatamente. O novo segredo aparece só nesta resposta.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: IdParams,
        response: { 200: SubscriptionWithSecretResponse, ...commonErrorResponses, ...authErrorResponses, ...subscriptionNotFound },
      },
    },
    async (request) => {
      const rotated = await service.rotateSecret(companyIdOf(request), request.params.subscriptionId, ownerContext(request));
      return { ...subscriptionJson(rotated.subscription), secret: rotated.secret };
    },
  );

  app.post(
    '/v1/webhook-subscriptions/:subscriptionId/test',
    {
      config: { auth: { scope: 'webhooks:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Enviar evento de teste',
        description: 'Agenda a entrega de um evento `webhook.test` só para esta assinatura, para conferir o destino e a assinatura HMAC.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: IdParams,
        response: {
          202: DeliveryResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          ...subscriptionNotFound,
          422: ProblemSchema.describe('WEBHOOK_SUBSCRIPTION_DISABLED'),
        },
      },
    },
    async (request, reply) => reply.status(202).send(deliveryJson(await service.sendTest(companyIdOf(request), request.params.subscriptionId, ownerContext(request)))),
  );

  app.get(
    '/v1/webhook-deliveries',
    {
      config: { auth: { scope: 'webhooks:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Listar entregas',
        description: 'Entregas das assinaturas da aplicação, mais recentes primeiro. Filtre por assinatura, evento ou status.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        querystring: DeliveryQuery,
        response: { 200: z.object({ items: z.array(DeliveryResponse) }), ...commonErrorResponses, ...authErrorResponses },
      },
    },
    async (request) => ({
      items: (
        await service.listDeliveries(companyIdOf(request), callerOf(request).clientApplicationId, {
          limit: request.query.limit,
          ...(request.query.subscriptionId !== undefined ? { subscriptionId: request.query.subscriptionId } : {}),
          ...(request.query.eventId !== undefined ? { eventId: request.query.eventId } : {}),
          ...(request.query.status !== undefined ? { status: request.query.status } : {}),
        })
      ).map(deliveryJson),
    }),
  );

  app.get(
    '/v1/webhook-deliveries/:deliveryId',
    {
      config: { auth: { scope: 'webhooks:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar entrega',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: DeliveryParams,
        response: { 200: DeliveryResponse, ...commonErrorResponses, ...authErrorResponses, ...deliveryNotFound },
      },
    },
    async (request) => deliveryJson(await service.getDelivery(companyIdOf(request), callerOf(request).clientApplicationId, request.params.deliveryId)),
  );

  app.post(
    '/v1/webhook-deliveries/:deliveryId/redeliver',
    {
      config: { auth: { scope: 'webhooks:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Reenviar entrega',
        description: 'Cria uma nova entrega do mesmo evento (mesmo `webhook-id`) para a mesma assinatura, com tentativas zeradas.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: DeliveryParams,
        response: { 202: DeliveryResponse, ...commonErrorResponses, ...authErrorResponses, ...deliveryNotFound, 422: ProblemSchema.describe('WEBHOOK_SUBSCRIPTION_DISABLED') },
      },
    },
    async (request, reply) => reply.status(202).send(deliveryJson(await service.redeliver(companyIdOf(request), request.params.deliveryId, ownerContext(request)))),
  );
}
