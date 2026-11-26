import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, callerOf, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { ConsumerInvoiceService } from '../../application/consumer-invoice-service.js';
import type { ConsumerInvoice, FiscalEnvironment } from '../../application/ports.js';
import { CONSUMER_INVOICE_STATUSES } from '../../domain/consumer-invoice.js';
import { consumerSaleSchema } from './consumer-sale-schema.js';

const TAG = 'NFC-e';

/** Venda v1 (ADR-0069) + onde emitir. Campos fora do contrato são recusados. */
const ConsumerInvoiceBody = consumerSaleSchema
  .extend({
    establishmentId: z.uuid().meta({ description: 'Estabelecimento emitente (com perfil estadual e série de NFC-e ativa).' }),
    seriesId: z.uuid().optional().meta({ description: 'Série de NFC-e; opcional quando o estabelecimento tem uma só ativa no ambiente.' }),
  })
  .meta({ id: 'CreateConsumerInvoice' });

const IdempotencyHeaders = CompanyHeaders.extend({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .meta({ description: 'Obrigatório. Repetir a mesma chave com o mesmo corpo devolve a mesma nota (nunca emite outra).' }),
});

const ConsumerInvoiceResponse = z
  .object({
    id: z.uuid(),
    status: z.enum(CONSUMER_INVOICE_STATUSES).meta({
      description:
        'PENDING/PROCESSING: em andamento. AUTHORIZED: autorizada. REJECTED: rejeitada (nada foi gravado no autorizador). DENIED: uso denegado (a nota foi gravada e o número consumido). ' +
        'FAILED: falha local antes de qualquer envio. UNKNOWN: em verificação pela consulta da chave; não emita outra.',
    }),
    establishmentId: z.uuid(),
    environment: z.enum(['PRODUCTION', 'HOMOLOGATION']),
    series: z.string(),
    number: z.number().int(),
    externalReference: z.string().nullable(),
    accessKey: z.string().nullable().meta({ description: 'Chave de acesso (44 posições) da nota autorizada ou denegada.' }),
    authorizer: z
      .object({ statusCode: z.string(), protocolNumber: z.string().nullable(), authorizedAt: z.iso.datetime().nullable() })
      .nullable()
      .meta({ description: 'Resposta do autorizador (cStat e protocolo), quando a nota foi gravada lá.' }),
    rejection: z.object({ code: z.string(), message: z.string() }).nullable(),
    failureCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    links: z.object({ self: z.string() }),
  })
  .meta({ id: 'ConsumerInvoice' });

const invoicePath = (id: string): string => `/v1/consumer-invoices/${id}`;

function invoiceJson(i: ConsumerInvoice): z.infer<typeof ConsumerInvoiceResponse> {
  return {
    id: i.id,
    status: i.status,
    establishmentId: i.establishmentId,
    environment: i.environment,
    series: i.series,
    number: i.number,
    externalReference: i.externalReference,
    accessKey: i.accessKey,
    authorizer:
      i.authorizerStatusCode === null ? null : { statusCode: i.authorizerStatusCode, protocolNumber: i.protocolNumber, authorizedAt: i.authorizedAt?.toISOString() ?? null },
    rejection: i.rejectionCode === null ? null : { code: i.rejectionCode, message: i.rejectionMessage ?? '' },
    failureCode: i.failureCode,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    links: { self: invoicePath(i.id) },
  };
}

/** JSON canônico (chaves ordenadas) para o hash do pedido (ADR-0007). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(',')}}`;
}

const environmentOf = (credential: 'live' | 'test'): FiscalEnvironment => (credential === 'live' ? 'PRODUCTION' : 'HOMOLOGATION');

export function registerNfceRoutes(app: HttpApp, service: ConsumerInvoiceService): void {
  app.post(
    '/v1/consumer-invoices',
    {
      config: { auth: { scope: 'nfce:issue', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Emitir NFC-e',
        description:
          'Aceita a venda, reserva o número e devolve 202 com status PENDING; a transmissão é assíncrona (acompanhe por GET). ' +
          'Os dados fiscais da venda (CFOP, NCM, CSOSN, PIS/COFINS, valores) são seus: o motor confere o formato do leiaute e as regras oficiais da NFC-e (ADR-0069), e nunca os escolhe. ' +
          'O emitente sai do cadastro do estabelecimento (perfil estadual, ADR-0071). O ambiente vem da credencial. ' +
          'Repetir a mesma `Idempotency-Key` com o mesmo corpo devolve 200 com a mesma nota.',
        security: [{ apiKey: [] }],
        headers: IdempotencyHeaders,
        body: ConsumerInvoiceBody,
        response: {
          200: ConsumerInvoiceResponse.describe('Repetição idempotente: a nota já aceita.'),
          202: ConsumerInvoiceResponse,
          ...commonErrorResponses,
          400: ProblemSchema.describe('VALIDATION_FAILED: corpo fora do contrato (formatos e tamanhos do XSD do PL_010h) ou sem Idempotency-Key.'),
          ...authErrorResponses,
          403: ProblemSchema.describe('Sem escopo/concessão, ou PRODUCTION_NOT_ENABLED.'),
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND'),
          409: ProblemSchema.describe('DOCUMENT_IN_PROGRESS ou DOCUMENT_ALREADY_AUTHORIZED (referência externa ocupada).'),
          422: ProblemSchema.describe(
            'NFCE_RULES_VIOLATED (regras oficiais, todas em issues com ruleId), NFCE_STATE_PROFILE_REQUIRED, IDEMPOTENCY_KEY_REUSED, NFCE_SERIES_NOT_AVAILABLE, NFCE_SERIES_REQUIRED, ESTABLISHMENT_INACTIVE.',
          ),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const environment = environmentOf(caller.environment);
      const { establishmentId, seriesId, ...sale } = request.body;
      const requestHash = createHash('sha256').update(canonical({ environment, body: request.body })).digest('hex');
      const result = await withIssueFields('body', () =>
        service.accept(
          { companyId: companyIdOf(request), clientApplicationId: caller.clientApplicationId, environment, establishmentId, seriesId, idempotencyKey: request.headers['idempotency-key'], requestHash, sale },
          auditContextOf(request),
        ),
      );
      return reply
        .status(result.replayed ? 200 : 202)
        .header('location', invoicePath(result.invoice.id))
        .send(invoiceJson(result.invoice));
    },
  );

  app.get(
    '/v1/consumer-invoices',
    {
      config: { auth: { scope: 'nfce:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar NFC-e pela referência externa',
        description:
          'Notas da aplicação com a `externalReference`, no ambiente da credencial, da mais nova para a mais antiga (até 50). ' +
          'Use quando a resposta do POST se perdeu: se houver nota que não seja REJECTED nem FAILED, ela é a sua; **não emita outra**.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        querystring: z.object({ externalReference: z.string().min(1).max(100).meta({ description: 'A referência enviada na emissão.' }) }),
        response: { 200: z.object({ items: z.array(ConsumerInvoiceResponse) }), ...commonErrorResponses, ...authErrorResponses },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      const items = await service.listByExternalReference(companyIdOf(request), caller.clientApplicationId, environmentOf(caller.environment), request.query.externalReference);
      return { items: items.map(invoiceJson) };
    },
  );

  app.get(
    '/v1/consumer-invoices/:id',
    {
      config: { auth: { scope: 'nfce:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar NFC-e',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: {
          200: ConsumerInvoiceResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('CONSUMER_INVOICE_NOT_FOUND (inexistente, de outra empresa, de outra aplicação ou de outro ambiente).'),
        },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      return invoiceJson(await service.get(companyIdOf(request), caller.clientApplicationId, environmentOf(caller.environment), request.params.id));
    },
  );
}
