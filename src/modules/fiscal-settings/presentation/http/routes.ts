import { z } from 'zod';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { authErrorResponses, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { FiscalSettingsService } from '../../application/fiscal-settings-service.js';
import { DOCUMENT_KINDS, FISCAL_ENVIRONMENTS, type DocumentSeries } from '../../domain/document-series.js';

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
        body: CreateSeriesBody,
        response: {
          201: SeriesResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: notFound,
          409: ProblemSchema.describe('DOCUMENT_SERIES_ALREADY_EXISTS'),
        },
      },
    },
    async (request, reply) => {
      const series = await withIssueFields('body', () =>
        service.createSeries(companyIdOf(request), request.params.establishmentId, request.body),
      );
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
}
