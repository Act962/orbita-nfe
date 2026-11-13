import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, callerOf, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { CancellationService } from '../../application/cancellation.js';
import type { ServiceInvoiceService } from '../../application/service-invoice-service.js';
import type { ServiceInvoice, ServiceInvoiceCancellation } from '../../application/ports.js';
import { CANCELLATION_REASON_CODES, CANCELLATION_STATES, REASON_TEXT_MAX, REASON_TEXT_MIN } from '../../domain/cancellation.js';
import {
  ISSQN_RETENTIONS,
  ISSQN_TAXATIONS,
  SIMPLES_NACIONAL_OPTIONS,
  SIMPLES_NACIONAL_REGIMES,
  SPECIAL_TAX_REGIMES,
} from '../../domain/dps.js';
import { SERVICE_INVOICE_STATUSES } from '../../domain/service-invoice.js';
import { SUBSTITUTION_REASON_CODES } from '../../domain/substitution.js';

const TAG = 'NFS-e';

// Padrões copiados dos tipos simples do XSD oficial (tiposSimples_v1.01.xsd), ancorados.
const DEC15V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]{0,14}(\.[0-9]{2})?)$/; // TSDec15V2
const DEC1V2 = /^(0|[0-9](\.[0-9]{2})?)$/; // TSDec1V2
const DEC2V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]?(\.[0-9]{2})?)$/; // TSDec2V2
const DEC3V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]{0,2}(\.[0-9]{2})?)$/; // TSDec3V2
const DATE = /^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/; // TSData (o XSD confere também dias por mês)
/** TSString: sem espaço no início nem no fim, só caracteres até U+00FF. */
const XSD_STRING = /^[!-ÿ]([ -ÿ]*[!-ÿ])?$/;

const money = (element: string) => z.string().regex(DEC15V2).meta({ description: `${element}: valor em R$ com ponto decimal e 2 casas (ex.: "1500.00").` });

const DpsBody = z
  .object({
    establishmentId: z.uuid(),
    seriesId: z.uuid().optional().meta({ description: 'Obrigatório só se o estabelecimento tiver mais de uma série de DPS ativa no ambiente.' }),
    externalReference: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .meta({ description: 'Sua referência (ex.: id do pedido). Única enquanto a nota não estiver REJECTED ou FAILED.' }),
    competenceDate: z.string().regex(DATE).meta({ description: 'dCompet: data de competência (AAAA-MM-DD).' }),
    provider: z
      .object({
        simplesNacionalOption: z.enum(SIMPLES_NACIONAL_OPTIONS).meta({ description: 'opSimpNac: 1 - Não optante; 2 - MEI; 3 - ME/EPP.' }),
        simplesNacionalRegime: z.enum(SIMPLES_NACIONAL_REGIMES).optional().meta({ description: 'regApTribSN (só ME/EPP, opSimpNac 3), conforme o XSD.' }),
        specialTaxRegime: z.enum(SPECIAL_TAX_REGIMES).meta({ description: 'regEspTrib (0 - Nenhum; demais códigos conforme o XSD).' }),
        municipalRegistration: z.string().min(1).max(15).regex(XSD_STRING).optional().meta({ description: 'IM do prestador.' }),
      })
      .strict(),
    taker: z
      .object({
        document: z.discriminatedUnion('type', [
          z.object({ type: z.literal('CNPJ'), value: z.string().regex(/^[0-9A-Z]{12}[0-9]{2}$/) }).strict(),
          z.object({ type: z.literal('CPF'), value: z.string().regex(/^[0-9]{11}$/) }).strict(),
        ]),
        name: z.string().min(1).max(300).meta({ description: 'xNome do tomador.' }),
        municipalRegistration: z.string().min(1).max(15).regex(XSD_STRING).optional(),
        email: z.string().min(1).max(80).regex(XSD_STRING).optional(),
      })
      .strict()
      .optional()
      .meta({ description: 'Tomador (toma). Endereço e intermediário ainda não fazem parte do contrato v1.' }),
    service: z
      .object({
        municipalityCode: z.string().regex(/^[0-9]{7}$/).meta({ description: 'cLocPrestacao: município da prestação (IBGE).' }),
        nationalTaxCode: z.string().regex(/^[0-9]{6}$/).meta({ description: 'cTribNac (6 dígitos). Escolha do contribuinte/contador.' }),
        municipalTaxCode: z.string().regex(/^[0-9]{3}$/).optional().meta({ description: 'cTribMun (3 dígitos).' }),
        nbsCode: z.string().regex(/^[0-9]{9}$/).optional().meta({ description: 'cNBS (9 dígitos).' }),
        description: z.string().min(1).max(2000).refine((v) => /\S/.test(v), 'A descrição não pode ser só espaços.').meta({ description: 'xDescServ.' }),
      })
      .strict(),
    values: z
      .object({
        serviceAmount: money('vServ'),
        issqn: z
          .object({
            taxation: z.enum(ISSQN_TAXATIONS).meta({ description: 'tribISSQN: 1 - Tributável; 2 - Imunidade; 3 - Exportação; 4 - Não incidência.' }),
            retention: z.enum(ISSQN_RETENTIONS).meta({ description: 'tpRetISSQN: 1 - Não retido; 2 - Retido pelo tomador; 3 - Retido pelo intermediário.' }),
            rate: z.string().regex(DEC1V2).optional().meta({ description: 'pAliq (%), ex.: "2.00".' }),
          })
          .strict(),
        approximateTaxes: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('AMOUNTS'), federal: money('vTotTribFed'), state: money('vTotTribEst'), municipal: money('vTotTribMun') }).strict(),
            z
              .object({
                kind: z.literal('PERCENTAGES'),
                federal: z.string().regex(DEC3V2),
                state: z.string().regex(DEC3V2),
                municipal: z.string().regex(DEC3V2),
              })
              .strict(),
            z.object({ kind: z.literal('SIMPLES_NACIONAL_RATE'), rate: z.string().regex(DEC2V2) }).strict(),
            z.object({ kind: z.literal('NOT_INFORMED') }).strict(),
          ])
          .meta({ description: 'totTrib (Lei 12.741/2012): AMOUNTS (vTotTrib), PERCENTAGES (pTotTrib), SIMPLES_NACIONAL_RATE (pTotTribSN) ou NOT_INFORMED (indTotTrib = 0).' }),
      })
      .strict(),
  })
  .strict()
  .meta({ id: 'IssueServiceInvoice', description: 'Contrato v1 da DPS (ADR-0033). Os valores fiscais são do contribuinte: o motor não escolhe nenhum.' });

const IdempotencyHeaders = CompanyHeaders.extend({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .meta({ description: 'Obrigatório. Repetir a mesma chave com o mesmo corpo devolve a mesma nota (nunca emite outra).' }),
});

const ServiceInvoiceResponse = z
  .object({
    id: z.uuid(),
    status: z.enum(SERVICE_INVOICE_STATUSES).meta({
      description:
        'PENDING/PROCESSING: em andamento. AUTHORIZED: autorizada. REJECTED: rejeitada pelo autorizador. FAILED: falha local antes de qualquer envio. ' +
        'UNKNOWN: em verificação junto ao autorizador — NÃO reemita; o motor consulta e resolve. CANCELLED: cancelamento registrado no autorizador. ' +
        'SUBSTITUTED: substituída por outra NFS-e já autorizada (`substitutedById`).',
    }),
    environment: z.enum(['PRODUCTION', 'HOMOLOGATION']),
    establishmentId: z.uuid(),
    externalReference: z.string().nullable(),
    dpsId: z.string().meta({ description: 'Identificador da DPS (TSIdDPS, 45 posições).' }),
    series: z.string(),
    number: z.number().int(),
    accessKey: z.string().nullable().meta({ description: 'Chave de acesso da NFS-e (quando AUTHORIZED).' }),
    authorizedAt: z.iso.datetime().nullable(),
    rejection: z.object({ code: z.string(), message: z.string() }).nullable().meta({ description: 'Código e mensagem do autorizador (REJECTED).' }),
    failureCode: z.string().nullable().meta({ description: 'Motivo da falha local (FAILED), ex.: CERTIFICATE_EXPIRED, DPS_SCHEMA_INVALID.' }),
    substitution: z
      .object({ serviceInvoiceId: z.uuid(), reasonCode: z.enum(SUBSTITUTION_REASON_CODES), reasonText: z.string().nullable() })
      .nullable()
      .meta({ description: 'Nesta nota substituta: a NFS-e que ela substitui e o motivo.' }),
    substitutedById: z.uuid().nullable().meta({ description: 'Na nota SUBSTITUTED: a substituta autorizada.' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ServiceInvoice' });

const invoiceJson = (i: ServiceInvoice): z.infer<typeof ServiceInvoiceResponse> => ({
  id: i.id,
  status: i.status,
  environment: i.environment,
  establishmentId: i.establishmentId,
  externalReference: i.externalReference,
  dpsId: i.dpsId,
  series: i.series,
  number: i.number,
  accessKey: i.nfseAccessKey,
  authorizedAt: i.authorizedAt?.toISOString() ?? null,
  rejection: i.rejectionCode === null ? null : { code: i.rejectionCode, message: i.rejectionMessage ?? '' },
  failureCode: i.failureCode,
  substitution: i.substitution === null ? null : { serviceInvoiceId: i.substitution.invoiceId, reasonCode: i.substitution.reasonCode, reasonText: i.substitution.reasonText },
  substitutedById: i.substitutedById,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
});

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

/** Substituição (ADR-0036): a mesma DPS do contrato v1, sem o estabelecimento (é o da original). */
const SubstitutionBody = DpsBody.omit({ establishmentId: true })
  .extend({
    substitution: z
      .object({
        reasonCode: z.enum(SUBSTITUTION_REASON_CODES).meta({
          description:
            'cMotivo (TSCodJustSubst): 01 Desenquadramento do Simples Nacional; 02 Enquadramento no Simples Nacional; 03 Inclusão retroativa de imunidade/isenção; ' +
            '04 Exclusão retroativa de imunidade/isenção; 05 Rejeição pelo tomador ou intermediário responsável pelo recolhimento; 99 Outros. Escolha do contribuinte.',
        }),
        reasonText: z
          .string()
          .min(REASON_TEXT_MIN)
          .max(REASON_TEXT_MAX)
          .regex(XSD_STRING)
          .optional()
          .meta({ description: 'xMotivo (TSMotivo, de 15 a 255 caracteres). Obrigatório com o motivo 99 (E0078).' }),
      })
      .strict(),
  })
  .strict()
  .meta({
    id: 'SubstituteServiceInvoice',
    description: 'Contrato v1 da DPS da nota substituta, com o motivo. Para MEI e ME/EPP, tomador, competência e valor do serviço não podem mudar (E0061).',
  });

const CancellationBody = z
  .object({
    reasonCode: z.enum(CANCELLATION_REASON_CODES).meta({ description: 'cMotivo (TSCodJustCanc): 1 Erro na Emissão; 2 Serviço não Prestado; 9 Outros. Escolha do contribuinte.' }),
    reasonText: z
      .string()
      .min(REASON_TEXT_MIN)
      .max(REASON_TEXT_MAX)
      .regex(XSD_STRING)
      .meta({ description: 'xMotivo (TSMotivo): de 15 a 255 caracteres, sem espaços nas pontas.' }),
  })
  .strict();

const CancellationResponse = z
  .object({
    id: z.uuid(),
    serviceInvoiceId: z.uuid(),
    status: z.enum(CANCELLATION_STATES).meta({
      description:
        'PENDING/PROCESSING: em andamento. REGISTERED: cancelada (a nota fica CANCELLED). REJECTED: recusado pelo autorizador; a nota continua autorizada. ' +
        'FAILED: falha local antes de qualquer envio. UNKNOWN: em verificação — NÃO peça de novo; o motor consulta e resolve.',
    }),
    reasonCode: z.enum(CANCELLATION_REASON_CODES),
    reasonText: z.string(),
    rejection: z.object({ code: z.string(), message: z.string() }).nullable(),
    failureCode: z.string().nullable(),
    registeredAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ServiceInvoiceCancellation' });

const cancellationJson = (c: ServiceInvoiceCancellation): z.infer<typeof CancellationResponse> => ({
  id: c.id,
  serviceInvoiceId: c.invoiceId,
  status: c.state,
  reasonCode: c.reasonCode,
  reasonText: c.reasonText,
  rejection: c.state === 'REJECTED' ? { code: c.outcomeCode ?? '', message: c.rejectionMessage ?? '' } : null,
  failureCode: c.failureCode,
  registeredAt: c.registeredAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export function registerNfseRoutes(app: HttpApp, service: ServiceInvoiceService, cancellations: CancellationService): void {
  app.post(
    '/v1/service-invoices/:id/cancellation',
    {
      config: { auth: { scope: 'nfse:cancel', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Cancelar NFS-e',
        description:
          'Pede o cancelamento (evento e101101) de uma NFS-e AUTHORIZED. Devolve 202 com status PENDING; o registro é assíncrono (GET da cancelação ou webhook `service_invoice.cancellation_changed`). ' +
          'Repetir o mesmo corpo devolve 200 com o mesmo pedido. O motivo é do contribuinte. O prazo é o do município: se vencido, o autorizador rejeita.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        body: CancellationBody,
        response: {
          200: CancellationResponse.describe('Repetição: o pedido já existente.'),
          202: CancellationResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('SERVICE_INVOICE_NOT_FOUND (inexistente, de outra aplicação ou de outro ambiente).'),
          409: ProblemSchema.describe('CANCELLATION_ALREADY_REQUESTED: já há pedido ativo com outro motivo. SUBSTITUTION_IN_PROGRESS: a nota tem substituta em andamento.'),
          422: ProblemSchema.describe('SERVICE_INVOICE_NOT_AUTHORIZED ou NFSE_CHANNEL_NOT_AVAILABLE.'),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const environment = caller.environment === 'live' ? 'PRODUCTION' : 'HOMOLOGATION';
      const result = await withIssueFields('body', () =>
        cancellations.request(
          {
            companyId: companyIdOf(request),
            clientApplicationId: caller.clientApplicationId,
            environment,
            invoiceId: request.params.id,
            reasonCode: request.body.reasonCode,
            reasonText: request.body.reasonText,
          },
          auditContextOf(request),
        ),
      );
      return reply
        .status(result.replayed ? 200 : 202)
        .header('location', `/v1/service-invoices/${request.params.id}/cancellation`)
        .send(cancellationJson(result.cancellation));
    },
  );

  app.get(
    '/v1/service-invoices/:id/cancellation',
    {
      config: { auth: { scope: 'nfse:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar o cancelamento de uma NFS-e',
        description: 'O pedido de cancelamento mais recente da nota.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: {
          200: CancellationResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('SERVICE_INVOICE_NOT_FOUND ou CANCELLATION_NOT_FOUND.'),
        },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      const environment = caller.environment === 'live' ? 'PRODUCTION' : 'HOMOLOGATION';
      return cancellationJson(await cancellations.get(companyIdOf(request), caller.clientApplicationId, environment, request.params.id));
    },
  );

  app.post(
    '/v1/service-invoices/:id/substitution',
    {
      config: { auth: { scope: 'nfse:issue', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Substituir NFS-e',
        description:
          'Emite uma NFS-e nova que substitui uma AUTHORIZED (DPS com o grupo `subst`). Devolve 202 com a substituta em PENDING; a original continua AUTHORIZED até a substituta ser autorizada, ' +
          'e então vira SUBSTITUTED (o autorizador registra o cancelamento por substituição, e105102). Se a substituta for rejeitada, a original segue autorizada. ' +
          'Mesmo estabelecimento, ambiente e aplicação da original. Repetir a mesma `Idempotency-Key` com o mesmo corpo devolve 200 com a mesma substituta. ' +
          'O prazo é o do município: se vencido, o autorizador rejeita (E0050).',
        security: [{ apiKey: [] }],
        headers: IdempotencyHeaders,
        params: z.object({ id: z.uuid() }),
        body: SubstitutionBody,
        response: {
          200: ServiceInvoiceResponse.describe('Repetição idempotente: a substituta já aceita.'),
          202: ServiceInvoiceResponse,
          ...commonErrorResponses,
          400: ProblemSchema.describe('VALIDATION_FAILED: corpo fora do contrato, DPS fora do XSD, ou motivo 99 sem descrição (SUBSTITUTION_REASON_TEXT_REQUIRED).'),
          ...authErrorResponses,
          403: ProblemSchema.describe('Sem escopo/concessão, ou PRODUCTION_NOT_ENABLED.'),
          404: ProblemSchema.describe('SERVICE_INVOICE_NOT_FOUND (inexistente, de outra aplicação ou de outro ambiente).'),
          409: ProblemSchema.describe('SUBSTITUTION_IN_PROGRESS (já há substituta viva), CANCELLATION_IN_PROGRESS, DOCUMENT_IN_PROGRESS ou DOCUMENT_ALREADY_AUTHORIZED (referência externa ocupada).'),
          422: ProblemSchema.describe(
            'SERVICE_INVOICE_NOT_AUTHORIZED, NFSE_CHANNEL_NOT_AVAILABLE, SUBSTITUTION_LOCKED_FIELDS (campos travados pelo Anexo I, campo a campo em issues), NFSE_RULES_VIOLATED, IDEMPOTENCY_KEY_REUSED, NFSE_SERIES_NOT_AVAILABLE, NFSE_SERIES_REQUIRED.',
          ),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const environment = caller.environment === 'live' ? 'PRODUCTION' : 'HOMOLOGATION';
      const { seriesId, externalReference, substitution, ...dps } = request.body;
      const requestHash = createHash('sha256')
        .update(canonical({ environment, substitutes: request.params.id, body: request.body }))
        .digest('hex');
      const result = await withIssueFields('body', () =>
        service.substitute(
          {
            companyId: companyIdOf(request),
            clientApplicationId: caller.clientApplicationId,
            environment,
            originalId: request.params.id,
            seriesId,
            idempotencyKey: request.headers['idempotency-key'],
            requestHash,
            externalReference: externalReference ?? null,
            reason: { code: substitution.reasonCode, text: substitution.reasonText ?? null },
            dps,
          },
          auditContextOf(request),
        ),
      );
      return reply
        .status(result.replayed ? 200 : 202)
        .header('location', `/v1/service-invoices/${result.invoice.id}`)
        .send(invoiceJson(result.invoice));
    },
  );

  app.post(
    '/v1/service-invoices',
    {
      config: { auth: { scope: 'nfse:issue', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Emitir NFS-e',
        description:
          'Aceita a DPS, reserva o número e devolve 202 com status PENDING; a transmissão é assíncrona (acompanhe por GET ou pelo webhook `service_invoice.status_changed`). ' +
          'O ambiente vem da credencial: `fk_test_…` emite em homologação (produção restrita) e `fk_live_…` em produção, só com a habilitação ativa. ' +
          'Repetir a mesma `Idempotency-Key` com o mesmo corpo devolve 200 com a mesma nota.',
        security: [{ apiKey: [] }],
        headers: IdempotencyHeaders,
        body: DpsBody,
        response: {
          200: ServiceInvoiceResponse.describe('Repetição idempotente: a nota já aceita.'),
          202: ServiceInvoiceResponse,
          ...commonErrorResponses,
          400: ProblemSchema.describe('VALIDATION_FAILED: corpo fora do contrato, ou DPS fora do XSD oficial do ambiente (issues com code DPS_SCHEMA_INVALID). Falta de Idempotency-Key também.'),
          ...authErrorResponses,
          403: ProblemSchema.describe('Sem escopo/concessão, ou PRODUCTION_NOT_ENABLED (credencial live sem habilitação de produção).'),
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND'),
          409: ProblemSchema.describe('DOCUMENT_IN_PROGRESS ou DOCUMENT_ALREADY_AUTHORIZED (referência externa ocupada).'),
          422: ProblemSchema.describe(
            'NFSE_RULES_VIOLATED (regras do Anexo I: todas em issues, com code = código de rejeição oficial e field), NFSE_CHANNEL_NOT_AVAILABLE, IDEMPOTENCY_KEY_REUSED, NFSE_SERIES_NOT_AVAILABLE, NFSE_SERIES_REQUIRED, ESTABLISHMENT_INACTIVE.',
          ),
        },
      },
    },
    async (request, reply) => {
      const caller = callerOf(request);
      const environment = caller.environment === 'live' ? 'PRODUCTION' : 'HOMOLOGATION';
      const { establishmentId, seriesId, externalReference, ...dps } = request.body;
      const requestHash = createHash('sha256').update(canonical({ environment, body: request.body })).digest('hex');
      const result = await withIssueFields('body', () =>
        service.accept(
          {
            companyId: companyIdOf(request),
            clientApplicationId: caller.clientApplicationId,
            environment,
            establishmentId,
            seriesId,
            idempotencyKey: request.headers['idempotency-key'],
            requestHash,
            externalReference: externalReference ?? null,
            dps,
          },
          auditContextOf(request),
        ),
      );
      return reply
        .status(result.replayed ? 200 : 202)
        .header('location', `/v1/service-invoices/${result.invoice.id}`)
        .send(invoiceJson(result.invoice));
    },
  );

  app.get(
    '/v1/service-invoices/:id',
    {
      config: { auth: { scope: 'nfse:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar NFS-e',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: z.object({ id: z.uuid() }),
        response: { 200: ServiceInvoiceResponse, ...commonErrorResponses, ...authErrorResponses, 404: ProblemSchema.describe('SERVICE_INVOICE_NOT_FOUND (inexistente, de outra empresa, de outra aplicação ou de outro ambiente).') },
      },
    },
    async (request) => {
      const caller = callerOf(request);
      const environment = caller.environment === 'live' ? 'PRODUCTION' : 'HOMOLOGATION';
      return invoiceJson(await service.get(companyIdOf(request), caller.clientApplicationId, environment, request.params.id));
    },
  );
}
