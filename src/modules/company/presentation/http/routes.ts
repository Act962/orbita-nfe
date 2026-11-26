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

const StateProfileAddress = z
  .object({
    street: z.string().max(60).meta({ description: 'Logradouro (xLgr, 2 a 60 caracteres).', example: 'RUA TESTE' }),
    number: z.string().max(60).meta({ description: 'Número (nro, 1 a 60 caracteres).', example: '100' }),
    complement: z.string().max(60).nullable().meta({ description: 'Complemento (xCpl), opcional.' }),
    district: z.string().max(60).meta({ description: 'Bairro (xBairro, 2 a 60 caracteres).', example: 'CENTRO' }),
    postalCode: z.string().max(9).meta({ description: 'CEP (8 dígitos; aceita hífen).', example: '64000000' }),
    phone: z.string().max(20).nullable().meta({ description: 'Telefone com DDD (6 a 14 dígitos), opcional.' }),
  })
  .meta({ id: 'EstablishmentStateProfileAddress' });

const StateProfileResponse = z
  .object({
    stateRegistration: z.string().meta({ description: 'Inscrição estadual (TIe: 2 a 14 dígitos, ou ISENTO).', example: '123456789' }),
    taxRegime: z.enum(['1', '2', '3', '4']).meta({ description: 'CRT: 1 Simples Nacional; 2 Simples com excesso de sublimite; 3 Regime Normal; 4 MEI.' }),
    address: StateProfileAddress,
  })
  .meta({ id: 'EstablishmentStateProfile' });

const StateProfileBody = z
  .strictObject({
    stateRegistration: z.string().max(20).meta({ description: 'Inscrição estadual, só dígitos (ou ISENTO). Informada pelo contribuinte; o motor só confere o formato.' }),
    taxRegime: z.string().max(1).meta({ description: 'CRT do leiaute: 1, 2, 3 ou 4. Informado pelo contador, nunca deduzido pelo motor.' }),
    address: z.strictObject({
      street: z.string().max(60),
      number: z.string().max(60),
      complement: z.string().max(60).nullable().optional(),
      district: z.string().max(60),
      postalCode: z.string().max(9),
      phone: z.string().max(20).nullable().optional(),
    }),
  })
  .meta({ id: 'EstablishmentStateProfileInput' });

const EstablishmentResponse = z
  .object({
    id: z.uuid(),
    cnpj: z.string().meta({ description: 'CNPJ sem máscara (14 posições, numérico ou alfanumérico).', example: '12345678000195' }),
    tradeName: z.string().meta({ example: 'Matriz Teresina' }),
    municipalityCode: z.string().meta({ description: 'Código IBGE do município.', example: '2211001' }),
    municipalRegistration: z
      .string()
      .nullable()
      .meta({ description: 'Inscrição municipal (IM), só cadastro: NÃO é colocada na DPS. Na nota, a IM é a que você envia em provider.municipalRegistration.' }),
    stateProfile: StateProfileResponse.nullable().meta({
      description: 'Perfil estadual para NF-e/NFC-e (inscrição estadual, CRT e endereço do emitente). Nulo enquanto não informado; sem ele o estabelecimento não emite NFC-e.',
    }),
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
    municipalRegistration: z.string().max(15).optional().meta({ description: 'Inscrição municipal (TSInscMun, 1 a 15 caracteres). Só cadastro: não entra na DPS.' }),
  })
  .meta({ id: 'CreateEstablishment' });

const MunicipalRegistrationBody = z
  .strictObject({
    municipalRegistration: z.string().max(15).nullable().meta({ description: 'Inscrição municipal (1 a 15 caracteres); null apaga. Só cadastro: não entra na DPS.' }),
  })
  .meta({ id: 'EstablishmentMunicipalRegistration' });

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
  municipalRegistration: e.municipalRegistration,
  stateProfile: e.stateProfile,
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

  app.patch(
    '/v1/establishments/:establishmentId',
    {
      config: { auth: { scope: 'companies:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Alterar a inscrição municipal do estabelecimento',
        description:
          'Grava ou apaga (null) a inscrição municipal do estabelecimento (ADR-0061). É só cadastro: o motor NÃO coloca esta IM na DPS; ' +
          'na emissão, a IM do prestador continua sendo a que você envia em `provider.municipalRegistration`. A mudança é auditada.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        body: MunicipalRegistrationBody,
        response: {
          200: EstablishmentResponse,
          ...commonErrorResponses,
          ...authErrorResponses,
          404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND (inexistente ou de outra empresa).'),
        },
      },
    },
    async (request) =>
      establishmentJson(
        await withIssueFields('body', () =>
          service.changeMunicipalRegistration(companyIdOf(request), request.params.establishmentId, request.body.municipalRegistration, auditContextOf(request)),
        ),
      ),
  );

  const stateProfileResponses = {
    200: EstablishmentResponse,
    ...commonErrorResponses,
    ...authErrorResponses,
    404: ProblemSchema.describe('ESTABLISHMENT_NOT_FOUND (inexistente ou de outra empresa).'),
  };

  app.put(
    '/v1/establishments/:establishmentId/state-profile',
    {
      config: { auth: { scope: 'companies:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Gravar o perfil estadual do estabelecimento',
        description:
          'Grava a inscrição estadual, o CRT e o endereço do emitente usados na NF-e/NFC-e (ADR-0071). Os dados são do contribuinte e do contador: ' +
          'o motor confere só o formato do leiaute (TIe, CRT, TEnderEmi) e nunca os deduz. O nome do município e a UF vêm da tabela do IBGE ' +
          'pelo município do estabelecimento. Substitui o perfil inteiro; a mudança é auditada.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        body: StateProfileBody,
        response: stateProfileResponses,
      },
    },
    async (request) =>
      establishmentJson(
        await withIssueFields('body', () => service.changeStateProfile(companyIdOf(request), request.params.establishmentId, request.body, auditContextOf(request))),
      ),
  );

  app.delete(
    '/v1/establishments/:establishmentId/state-profile',
    {
      config: { auth: { scope: 'companies:manage', company: true } },
      schema: {
        tags: [TAG],
        summary: 'Apagar o perfil estadual do estabelecimento',
        description: 'Remove o perfil estadual (ADR-0071). Sem ele, o estabelecimento não emite NFC-e. A mudança é auditada.',
        security: [{ apiKey: [] }],
        headers: CompanyHeaders,
        params: EstablishmentParams,
        response: stateProfileResponses,
      },
    },
    async (request) => establishmentJson(await service.changeStateProfile(companyIdOf(request), request.params.establishmentId, null, auditContextOf(request))),
  );
}
