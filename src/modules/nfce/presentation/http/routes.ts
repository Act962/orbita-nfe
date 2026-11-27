import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { MAX_WAIT_SECONDS, settle, type WaitPolicy } from '../../../../shared/presentation/http/prefer-wait.js';
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
  prefer: z
    .string()
    .optional()
    .meta({ description: `Opcional. \`wait=<segundos>\` (RFC 7240, máximo ${String(MAX_WAIT_SECONDS)}): espera o resultado antes de responder.` }),
});

/**
 * `Prefer: wait` na NFC-e (ADR-0077). UNKNOWN não é final nem em andamento: a espera para e a
 * resposta é 202, porque a consulta pela chave leva mais tempo.
 */
const CONSUMER_INVOICE_WAIT: WaitPolicy<ConsumerInvoice> = {
  inFlight: (i) => i.status === 'PENDING' || i.status === 'PROCESSING',
  final: (i) => i.status === 'AUTHORIZED' || i.status === 'REJECTED' || i.status === 'DENIED' || i.status === 'FAILED',
};

const ValidationResponse = z
  .object({
    valid: z.literal(true),
    environment: z.enum(['PRODUCTION', 'HOMOLOGATION']),
    series: z.object({ id: z.uuid(), series: z.string() }).meta({ description: 'Série que seria usada. Nenhum número é reservado.' }),
  })
  .meta({ id: 'ConsumerInvoiceValidation' });

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
    links: z.object({
      self: z.string(),
      xml: z.string().nullable().meta({ description: 'XML autorizado (nfeProc), só na nota AUTHORIZED.' }),
      danfe: z.string().nullable().meta({ description: 'DANFE NFC-e em PDF, só na nota AUTHORIZED.' }),
    }),
  })
  .meta({ id: 'ConsumerInvoice' });

/** Diagnóstico (ADR-0078): só metadados e códigos. Nenhum XML, nenhum digest, nenhum dado do consumidor. */
const DiagnosticsResponse = z
  .object({
    consumerInvoiceId: z.uuid(),
    status: z.enum(CONSUMER_INVOICE_STATUSES),
    protocol: z.object({
      accessKey: z.string().nullable().meta({ description: 'Chave gravada pelo autorizador (nota autorizada ou denegada).' }),
      authorizerStatusCode: z.string().nullable(),
      protocolNumber: z.string().nullable(),
      nfeProcSha256: z.string().nullable().meta({ description: 'SHA-256 do nfeProc (o mesmo do ETag do download).' }),
      archivedAt: z.iso.datetime().nullable().meta({ description: 'Quando a cópia imutável foi gravada no bucket (ADR-0074).' }),
      retainUntil: z.iso.datetime().nullable(),
    }),
    attempts: z
      .array(
        z.object({
          seq: z.number().int(),
          state: z.string().meta({ description: 'PREPARED, SENDING ou CLOSED.' }),
          accessKey: z.string().meta({ description: 'Chave montada nesta tentativa (o XML é montado a cada tentativa, regra B09-40).' }),
          issuedAt: z.iso.datetime().meta({ description: 'dhEmi desta tentativa.' }),
          outcome: z.string().nullable().meta({ description: 'AUTHORIZED, REJECTED, DENIED, NOT_SENT, UNKNOWN, ALREADY_EXISTS, RECOVERED_NOT_SENT ou RECOVERED_UNKNOWN.' }),
          outcomeCode: z.string().nullable().meta({ description: 'cStat do autorizador ou código do erro de transporte. Nunca mensagem livre.' }),
          preparedAt: z.iso.datetime(),
          sendingAt: z.iso.datetime().nullable(),
          closedAt: z.iso.datetime().nullable(),
          lookups: z.number().int().meta({ description: 'Consultas pela chave desta tentativa.' }),
          consecutiveLookupErrors: z.number().int(),
        }),
      )
      .meta({ description: 'Tentativas de transmissão, da primeira para a última.' }),
  })
  .meta({ id: 'ConsumerInvoiceDiagnostics' });

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

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
    links: {
      self: invoicePath(i.id),
      xml: i.status === 'AUTHORIZED' ? `${invoicePath(i.id)}/xml` : null,
      danfe: i.status === 'AUTHORIZED' ? `${invoicePath(i.id)}/danfe` : null,
    },
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

interface BinaryReply {
  type(contentType: string): BinaryReply;
  header(name: string, value: string): BinaryReply;
  send(payload: Buffer): unknown;
}

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
          'Repetir a mesma `Idempotency-Key` com o mesmo corpo devolve 200 com a mesma nota. ' +
          'Com `Prefer: wait=<segundos>`, a resposta espera o resultado: 201 se a nota terminou dentro do prazo (AUTHORIZED, REJECTED, DENIED ou FAILED), 202 se ainda não (inclusive UNKNOWN).',
        security: [{ apiKey: [] }],
        headers: IdempotencyHeaders,
        body: ConsumerInvoiceBody,
        response: {
          200: ConsumerInvoiceResponse.describe('Repetição idempotente: a nota já aceita.'),
          201: ConsumerInvoiceResponse.describe('Com `Prefer: wait`: a nota terminou dentro da espera (AUTHORIZED, REJECTED, DENIED ou FAILED).'),
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
      const settled = await settle(
        request.headers.prefer,
        reply.raw,
        { value: result.invoice, replayed: result.replayed },
        () => service.get(companyIdOf(request), caller.clientApplicationId, environment, result.invoice.id),
        CONSUMER_INVOICE_WAIT,
      );
      if (settled.applied !== undefined) reply.header('preference-applied', settled.applied);
      return reply.status(settled.status).header('location', invoicePath(result.invoice.id)).send(invoiceJson(settled.value));
    },
  );

  app.post(
    '/v1/consumer-invoices/validation',
    {
      config: { auth: { scope: 'nfce:issue', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Validar NFC-e sem emitir',
        description:
          'Confere a venda como no `POST /v1/consumer-invoices`, na mesma ordem e com os mesmos erros: contrato, referência externa, estabelecimento, perfil estadual, ' +
          'regras oficiais da NFC-e (ADR-0069), habilitação de produção e série. **Não tem efeitos:** não numera, não grava, não audita nem transmite, e não pede Idempotency-Key. ' +
          'Passar aqui não garante a autorização: o cadastro do contribuinte e as regras que dependem da base da SEFAZ são do autorizador.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        body: ConsumerInvoiceBody,
        response: {
          200: ValidationResponse,
          ...commonErrorResponses,
          400: ProblemSchema.describe('VALIDATION_FAILED: corpo fora do contrato (formatos e tamanhos do XSD do PL_010h).'),
          ...authErrorResponses,
          403: ProblemSchema.describe('Sem escopo/concessão, ou PRODUCTION_NOT_ENABLED.'),
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND'),
          409: ProblemSchema.describe('DOCUMENT_IN_PROGRESS ou DOCUMENT_ALREADY_AUTHORIZED (referência externa ocupada).'),
          422: ProblemSchema.describe('NFCE_RULES_VIOLATED, NFCE_STATE_PROFILE_REQUIRED, NFCE_SERIES_NOT_AVAILABLE, NFCE_SERIES_REQUIRED, ESTABLISHMENT_INACTIVE.'),
        },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      const environment = environmentOf(caller.environment);
      const { establishmentId, seriesId, ...sale } = request.body;
      const result = await withIssueFields('body', () =>
        service.validate({ companyId: companyIdOf(request), clientApplicationId: caller.clientApplicationId, environment, establishmentId, seriesId, sale }),
      );
      return { valid: true as const, environment, series: { id: result.series.id, series: result.series.series } };
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
    '/v1/consumer-invoices/:id/xml',
    {
      config: { auth: { scope: 'nfce:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Baixar o XML da NFC-e',
        description:
          'XML da NFC-e autorizada no formato de distribuição `nfeProc` (a NFe assinada + o protocolo de autorização devolvido pelo autorizador), só na nota AUTHORIZED. ' +
          'Cabeçalhos: `ETag` com o SHA-256 dos bytes e `Repr-Digest: sha-256=:…:` (RFC 9530), para conferir o que chegou; `Cache-Control: private, no-store` (pode ter dados do consumidor).',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: {
          200: { description: 'XML autorizado (nfeProc).', content: { 'application/xml': { schema: z.string().meta({ description: 'nfeProc em UTF-8.' }) } } },
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('CONSUMER_INVOICE_NOT_FOUND ou NFCE_XML_NOT_AVAILABLE (nota que não foi autorizada).'),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const download = await service.authorizedXml(companyIdOf(request), caller.clientApplicationId, environmentOf(caller.environment), request.params.id);
      return reply
        .type('application/xml; charset=utf-8')
        .header('content-disposition', `attachment; filename="${download.fileName}"`)
        .header('etag', `"${download.sha256}"`)
        .header('repr-digest', `sha-256=:${Buffer.from(download.sha256, 'hex').toString('base64')}:`)
        .header('cache-control', 'private, no-store')
        .send(download.xml);
    },
  );

  app.get(
    '/v1/consumer-invoices/:id/danfe',
    {
      config: { auth: { scope: 'nfce:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Baixar o DANFE NFC-e (PDF)',
        description:
          'DANFE NFC-e conforme o Manual de Especificações Técnicas do DANFE NFC-e e QR Code v6.0 (divisões I a IX, QR Code centralizado), em bobina de 80 mm, ' +
          'gerado na hora a partir do XML autorizado (o documento fiscal é o XML). Só na nota AUTHORIZED. Em homologação traz "EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL".',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: {
          200: { description: 'DANFE NFC-e em PDF.', content: { 'application/pdf': { schema: z.string().meta({ format: 'binary' }) } } },
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('CONSUMER_INVOICE_NOT_FOUND, NFCE_XML_NOT_AVAILABLE (nota não autorizada) ou NFCE_DANFE_NOT_AVAILABLE.'),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const danfe = await service.danfe(companyIdOf(request), caller.clientApplicationId, environmentOf(caller.environment), request.params.id);
      // Buffer vai cru (o Fastify não serializa Buffer); o schema de 200 só documenta o PDF.
      (reply as unknown as BinaryReply)
        .type('application/pdf')
        .header('content-disposition', `inline; filename="${danfe.fileName}"`)
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(danfe.pdf));
    },
  );

  app.get(
    '/v1/consumer-invoices/:id/diagnostics',
    {
      config: { auth: { scope: 'nfce:debug', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Diagnóstico da NFC-e',
        description:
          'Para investigar uma nota: protocolo, arquivamento e cada tentativa de transmissão (chave e dhEmi montados, código do resultado e consultas pela chave). ' +
          'Só metadados e códigos: nenhum XML e nenhum dado do consumidor. Exige o escopo próprio `nfce:debug` (ADR-0078), que `nfce:read` não inclui.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: {
          200: DiagnosticsResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('CONSUMER_INVOICE_NOT_FOUND (inexistente, de outra empresa, de outra aplicação ou de outro ambiente).'),
        },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      const d = await service.diagnostics(companyIdOf(request), caller.clientApplicationId, environmentOf(caller.environment), request.params.id);
      return {
        consumerInvoiceId: d.invoice.id,
        status: d.invoice.status,
        protocol: {
          accessKey: d.invoice.accessKey,
          authorizerStatusCode: d.invoice.authorizerStatusCode,
          protocolNumber: d.invoice.protocolNumber,
          nfeProcSha256: d.archive.sha256,
          archivedAt: iso(d.archive.archivedAt),
          retainUntil: iso(d.archive.retainUntil),
        },
        attempts: d.attempts.map((a) => ({
          seq: a.seq,
          state: a.state,
          accessKey: a.accessKey,
          issuedAt: a.issuedAt.toISOString(),
          outcome: a.outcome,
          outcomeCode: a.outcomeCode,
          preparedAt: a.preparedAt.toISOString(),
          sendingAt: iso(a.sendingAt),
          closedAt: iso(a.closedAt),
          lookups: a.lookups,
          consecutiveLookupErrors: a.consecutiveLookupErrors,
        })),
      };
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
