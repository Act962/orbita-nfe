import { z } from 'zod';
import { DryRunQuery, dryRunResponse, isDryRun } from '../../../../shared/presentation/http/dry-run.js';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { withIssueFields } from '../../../../shared/presentation/http/issue-fields.js';
import { ProblemSchema, commonErrorResponses } from '../../../../shared/presentation/http/problem.js';
import { auditContextOf, authErrorResponses, companyIdOf, CompanyHeaders } from '../../../../shared/presentation/http/request-context.js';
import type { CompanyService } from '../../application/company-service.js';
import type { Establishment, Company } from '../../domain/company.js';

const TAG = 'Empresas';

const CompanyResponse = z
  .object({
    id: z.uuid(),
    legalName: z.string().meta({ example: 'EMPRESA FICTICIA LTDA' }),
    rootCnpj: z.string().meta({ description: 'Raiz do CNPJ (8 posições).', example: '12345678' }),
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Company' });

const EstablishmentResponse = z
  .object({
    id: z.uuid(),
    cnpj: z.string().meta({ description: 'CNPJ sem máscara (14 posições, numérico ou alfanumérico).', example: '12345678000195' }),
    tradeName: z.string().meta({ example: 'Matriz Teresina' }),
    municipalityCode: z.string().meta({ description: 'Código IBGE do município.', example: '2211001' }),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Establishment' });

const CreateCompanyBody = z
  .object({
    legalName: z.string().min(1).max(150).meta({ description: 'Razão social.' }),
    rootCnpj: z.string().min(8).max(10).meta({ description: 'Raiz do CNPJ (8 posições, aceita alfanumérico).', example: '12345678' }),
  })
  .meta({ id: 'CreateCompany' });

const CreateEstablishmentBody = z
  .object({
    cnpj: z.string().min(14).max(18).meta({ description: 'CNPJ completo, com ou sem máscara. A raiz precisa ser a da empresa.' }),
    tradeName: z.string().min(1).max(150),
    municipalityCode: z.string().regex(/^[0-9]{7}$/).meta({ description: 'Código IBGE do município (7 dígitos).' }),
  })
  .meta({ id: 'CreateEstablishment' });

const EstablishmentParams = z.object({ establishmentId: z.uuid() });

const companyJson = (t: Company): z.infer<typeof CompanyResponse> => ({
  id: t.id,
  legalName: t.legalName,
  rootCnpj: t.rootCnpj,
  status: t.status,
  createdAt: t.createdAt.toISOString(),
});

const establishmentJson = (e: Establishment): z.infer<typeof EstablishmentResponse> => ({
  id: e.id,
  cnpj: e.cnpj,
  tradeName: e.tradeName,
  municipalityCode: e.municipalityCode,
  status: e.status,
  createdAt: e.createdAt.toISOString(),
});

export function registerCompanyRoutes(app: HttpApp, service: CompanyService): void {
  app.post(
    '/v1/companies',
    {
      config: { auth: { scope: 'companies:create', company: false } },
      schema: {
        tags: [TAG],
        summary: 'Cadastrar empresa',
        description:
          'Cria a empresa (contribuinte identificado pela raiz do CNPJ) e concede à aplicação chamadora acesso a ela. O id é gerado pelo servidor.',
        security: [{ apiKey: [] }],
        querystring: DryRunQuery,
        body: CreateCompanyBody,
        response: {
          201: CompanyResponse,
          200: dryRunResponse(CompanyResponse, 'Company'),
          ...commonErrorResponses,
          ...authErrorResponses,
          409: ProblemSchema.describe('COMPANY_ALREADY_REGISTERED'),
        },
      },
    },
    async (request, reply) => {
      const dryRun = isDryRun(request.query);
      const company = await withIssueFields('body', () => service.registerCompany(request.body, auditContextOf(request), { dryRun }));
      if (dryRun) return reply.status(200).send({ dryRun: true, result: companyJson(company) });
      return reply.status(201).header('location', '/v1/company').send(companyJson(company));
    },
  );

  app.get(
    '/v1/company',
    {
      config: { auth: { scope: 'companies:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar a empresa do contexto',
        description: 'Retorna a empresa informada em X-Company-Id.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        response: { 200: CompanyResponse, ...commonErrorResponses, ...authErrorResponses },
      },
    },
    async (request) => companyJson(await service.currentCompany(companyIdOf(request))),
  );

  app.post(
    '/v1/establishments',
    {
      config: { auth: { scope: 'companies:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Cadastrar estabelecimento',
        description: 'Cadastra matriz ou filial da empresa. O CNPJ precisa ter a mesma raiz da empresa (regra COMPANY-001).',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        querystring: DryRunQuery,
        body: CreateEstablishmentBody,
        response: {
          201: EstablishmentResponse,
          200: dryRunResponse(EstablishmentResponse, 'Establishment'),
          ...commonErrorResponses,
          ...authErrorResponses,
          409: ProblemSchema.describe('ESTABLISHMENT_ALREADY_REGISTERED'),
          422: ProblemSchema.describe('ESTABLISHMENT_ROOT_MISMATCH'),
        },
      },
    },
    async (request, reply) => {
      const dryRun = isDryRun(request.query);
      const establishment = await withIssueFields('body', () =>
        service.registerEstablishment(companyIdOf(request), request.body, auditContextOf(request), { dryRun }),
      );
      if (dryRun) return reply.status(200).send({ dryRun: true, result: establishmentJson(establishment) });
      return reply.status(201).header('location', `/v1/establishments/${establishment.id}`).send(establishmentJson(establishment));
    },
  );

  app.get(
    '/v1/establishments',
    {
      config: { auth: { scope: 'companies:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Listar estabelecimentos',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        response: { 200: z.object({ items: z.array(EstablishmentResponse) }), ...commonErrorResponses, ...authErrorResponses },
      },
    },
    async (request) => ({ items: (await service.establishments(companyIdOf(request))).map(establishmentJson) }),
  );

  app.get(
    '/v1/establishments/:establishmentId',
    {
      config: { auth: { scope: 'companies:read', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Consultar estabelecimento',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        response: {
          200: EstablishmentResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND (inexistente ou de outra empresa).'),
        },
      },
    },
    async (request) => establishmentJson(await service.establishment(companyIdOf(request), request.params.establishmentId)),
  );
}
