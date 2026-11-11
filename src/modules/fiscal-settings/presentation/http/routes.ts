import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ForbiddenError } from '../../../../shared/application/errors.js';
import { DryRunQuery, dryRunResponse, isDryRun } from '../../../../shared/presentation/http/dry-run.js';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, callerOf, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { FiscalSettingsService } from '../../application/fiscal-settings-service.js';
import { DOCUMENT_KINDS, FISCAL_ENVIRONMENTS, type DocumentSeries } from '../../domain/document-series.js';
import { ENABLEMENT_STATUSES, MAX_REVOCATION_REASON_LENGTH, type ProductionEnablement } from '../../domain/production-enablement.js';

const TAG = 'Configurações fiscais';

const SeriesResponse = z
  .object({
    id: z.uuid(),
    establishmentId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS).meta({ description: 'NFSE_DPS (NFS-e Nacional), NFE (modelo 55) ou NFCE (modelo 65).' }),
    environment: z.enum(FISCAL_ENVIRONMENTS),
    series: z.string().meta({ example: '1' }),
    nextNumber: z.number().int().meta({ description: 'Próximo número a ser usado.' }),
    maxNumber: z.number().int().meta({ description: 'Último número permitido pela modalidade.' }),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'DocumentSeries' });

const CreateSeriesBody = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    environment: z.enum(FISCAL_ENVIRONMENTS),
    series: z.string().min(1).max(5).meta({ description: 'Série sem zeros à esquerda. NF-e/NFC-e: 0 a 999 (SERIES-001); DPS: 0 a 89999 (SERIES-002, provisória).' }),
    nextNumber: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: 'Para continuar a numeração de outro emissor. Padrão: 1. Nunca reutilize um número já transmitido.' }),
  })
  .meta({ id: 'CreateDocumentSeries' });

const Params = z.object({ establishmentId: z.uuid() });

const seriesJson = (s: DocumentSeries): z.infer<typeof SeriesResponse> => ({
  id: s.id,
  establishmentId: s.establishmentId,
  kind: s.kind,
  environment: s.environment,
  series: s.series,
  nextNumber: s.nextNumber,
  maxNumber: s.maxNumber,
  status: s.status,
  createdAt: s.createdAt.toISOString(),
});

const notFound = ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND (inexistente ou de outra empresa).');

const PRODUCTION_TAG = 'Habilitação de produção';

const EnablementResponse = z
  .object({
    id: z.uuid(),
    establishmentId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS),
    status: z.enum(ENABLEMENT_STATUSES),
    enabledAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    revocationReason: z.string().nullable(),
  })
  .meta({ id: 'ProductionEnablement' });

const EnableBody = z
  .object({
    kind: z.enum(DOCUMENT_KINDS),
    confirmCnpj: z
      .string()
      .min(14)
      .max(18)
      .meta({ description: 'Repita o CNPJ do estabelecimento (com ou sem máscara). Confirma que é o estabelecimento certo.' }),
  })
  .meta({ id: 'EnableProduction' });

const RevokeBody = z
  .object({ reason: z.string().min(1).max(MAX_REVOCATION_REASON_LENGTH).meta({ description: 'Motivo da revogação (vai para a auditoria). Não inclua dados pessoais.' }) })
  .meta({ id: 'RevokeProductionEnablement' });

const EnablementParams = z.object({ establishmentId: z.uuid(), enablementId: z.uuid() });

const enablementJson = (e: ProductionEnablement): z.infer<typeof EnablementResponse> => ({
  id: e.id,
  establishmentId: e.establishmentId,
  kind: e.kind,
  status: e.status,
  enabledAt: e.enabledAt.toISOString(),
  revokedAt: e.revokedAt?.toISOString() ?? null,
  revocationReason: e.revocationReason,
});

/** Segunda trava (ADR-0027): só uma credencial `live` mexe na habilitação de produção. */
function requireLiveCredential(request: FastifyRequest): void {
  if (callerOf(request).environment !== 'live') {
    throw new ForbiddenError('LIVE_CREDENTIAL_REQUIRED', 'A habilitação de produção só pode ser alterada com uma credencial live.');
  }
}

const PRODUCTION_DOC =
  'Duas travas independentes precisam concordar para um documento ir à produção: a credencial `live` e a habilitação da modalidade no estabelecimento. ' +
  'Estabelecimento novo nasce só com homologação. Alterar a habilitação exige o escopo `production:manage` e uma credencial `live`.';

export function registerFiscalSettingsRoutes(app: HttpApp, service: FiscalSettingsService): void {
  app.post(
    '/v1/establishments/:establishmentId/document-series',
    {
      config: { auth: { scope: 'fiscal-settings:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Criar série de documentos',
        description: 'Cria a série de numeração de uma modalidade e ambiente. A numeração é alocada de forma transacional na emissão (ADR-0008).',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: Params,
        querystring: DryRunQuery,
        body: CreateSeriesBody,
        response: {
          201: SeriesResponse,
          200: dryRunResponse(SeriesResponse, 'DocumentSeries'),
          ...commonErrorResponses,
          ...authErrorResponses,
          404: notFound,
          409: ProblemSchema.describe('DOCUMENT_SERIES_ALREADY_EXISTS'),
        },
      },
    },
    async (request, reply) => {
      const dryRun = isDryRun(request.query);
      const series = await withIssueFields('body', () =>
        service.createSeries(companyIdOf(request), request.params.establishmentId, request.body, auditContextOf(request), { dryRun }),
      );
      if (dryRun) return reply.status(200).send({ dryRun: true, result: seriesJson(series) });
      return reply.status(201).send(seriesJson(series));
    },
  );

  app.get(
    '/v1/establishments/:establishmentId/document-series',
    {
      config: { auth: { scope: 'fiscal-settings:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Listar séries do estabelecimento',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: Params,
        response: { 200: z.object({ items: z.array(SeriesResponse) }), ...commonErrorResponses, ...authErrorResponses, 404: notFound },
      },
    },
    async (request) => ({ items: (await service.listSeries(companyIdOf(request), request.params.establishmentId)).map(seriesJson) }),
  );

  app.get(
    '/v1/establishments/:establishmentId/production-enablements',
    {
      config: { auth: { scope: 'production:read', company: true } },
      schema: {
        tags: [PRODUCTION_TAG],
        summary: 'Listar habilitações de produção',
        description: `Histórico completo (ativas e revogadas) por modalidade. ${PRODUCTION_DOC}`,
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: Params,
        response: { 200: z.object({ items: z.array(EnablementResponse) }), ...commonErrorResponses, ...authErrorResponses, 404: notFound },
      },
    },
    async (request) => ({
      items: (await service.listProductionEnablements(companyIdOf(request), request.params.establishmentId)).map(enablementJson),
    }),
  );

  app.post(
    '/v1/establishments/:establishmentId/production-enablements',
    {
      config: { auth: { scope: 'production:manage', company: true } },
      schema: {
        tags: [PRODUCTION_TAG],
        summary: 'Habilitar modalidade para produção',
        description:
          `${PRODUCTION_DOC} Pré-requisitos (regra PROD-001): estabelecimento ativo, certificado ACTIVE e dentro da validade, ` +
          'série ACTIVE de produção da modalidade e `confirmCnpj` igual ao CNPJ do estabelecimento. Aceita `dryRun=true`.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: Params,
        querystring: DryRunQuery,
        body: EnableBody,
        response: {
          201: EnablementResponse,
          200: dryRunResponse(EnablementResponse, 'ProductionEnablement'),
          ...commonErrorResponses,
          ...authErrorResponses,
          404: notFound,
          409: ProblemSchema.describe('PRODUCTION_ALREADY_ENABLED'),
          422: ProblemSchema.describe('PRODUCTION_PREREQUISITES_NOT_MET (os itens de `issues` dizem quais faltam)'),
        },
      },
    },
    async (request, reply) => {
      requireLiveCredential(request);
      const dryRun = isDryRun(request.query);
      const enablement = await withIssueFields('body', () =>
        service.enableProduction(companyIdOf(request), request.params.establishmentId, request.body, auditContextOf(request), { dryRun }),
      );
      if (dryRun) return reply.status(200).send({ dryRun: true, result: enablementJson(enablement) });
      return reply.status(201).send(enablementJson(enablement));
    },
  );

  app.post(
    '/v1/establishments/:establishmentId/production-enablements/:enablementId/revocation',
    {
      config: { auth: { scope: 'production:manage', company: true } },
      schema: {
        tags: [PRODUCTION_TAG],
        summary: 'Revogar habilitação de produção',
        description: `A partir da revogação, a modalidade volta a operar só em homologação no estabelecimento. ${PRODUCTION_DOC}`,
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EnablementParams,
        body: RevokeBody,
        response: {
          200: EnablementResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND ou PRODUCTION_ENABLEMENT_NOT_FOUND (inexistente, já revogada ou de outra empresa).'),
        },
      },
    },
    async (request) => {
      requireLiveCredential(request);
      return enablementJson(
        await withIssueFields('body', () =>
          service.revokeProduction(companyIdOf(request), request.params.establishmentId, request.params.enablementId, request.body, auditContextOf(request)),
        ),
      );
    },
  );
}
