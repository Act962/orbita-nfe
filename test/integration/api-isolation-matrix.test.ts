import { sql } from 'drizzle-orm';
import { sampleDpsData } from '../support/dps-fixtures.js';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCOPES } from '../../src/modules/iam/public.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import type { RouteCatalogEntry } from '../../src/shared/presentation/http/route-catalog.js';
import { bearer, cnpjOf, createClientApp, createEstablishment, createCompany, fakeRoot, problemCode, startTestApi, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Matriz de isolamento da API (docs/architecture/14 §B4, testes 2, 7 e 8).
 *
 * Gerada do catálogo de rotas do Fastify: para TODA rota de empresa,
 *   1. sem credencial → 401;
 *   2. aplicação B pedindo a empresa A (sem concessão) → 403 COMPANY_ACCESS_DENIED;
 *   3. aplicação B na própria empresa apontando para recursos/dados de A → 404 ou nada de A.
 * Rota de empresa nova sem caso nesta matriz faz o teste falhar.
 */
interface Party {
  readonly key: string;
  readonly companyId: string;
  readonly root: string;
  readonly establishmentId: string;
  readonly establishmentCnpj: string;
  readonly seriesId: string;
  readonly certificateId: string;
  readonly subscriptionId: string;
  readonly deliveryId: string;
  readonly enablementId: string;
  readonly invoiceId: string;
}

interface Ctx {
  readonly a: Party;
  readonly b: Party;
}

interface MatrixCase {
  /** Corpo da requisição (rotas com body). */
  readonly payload?: (ctx: Ctx) => Record<string, unknown>;
  /** Headers extras da rota (ex.: Idempotency-Key). */
  readonly headers?: Record<string, string>;
  /** Requisição de B, na empresa B, usando ids/dados de A: o que se espera. */
  readonly expectCrossCompany: (res: LightMyRequestResponse, ctx: Ctx) => void;
}

/** Conteúdo qualquer: a matriz testa isolamento, não a validação do certificado (que é do worker). */
const DUMMY_PFX = Buffer.from('nao-e-um-pfx-de-verdade').toString('base64');

const expectNotFound = (code: string) => (res: LightMyRequestResponse) => {
  expect(res.statusCode).toBe(404);
  expect(problemCode(res)).toBe(code);
};

const CASES: Record<string, MatrixCase> = {
  'GET /v1/company': {
    expectCrossCompany: (res, { a, b }) => {
      expect(res.statusCode).toBe(200);
      expect(res.json<{ id: string }>().id).toBe(b.companyId);
      expect(res.body).not.toContain(a.companyId);
    },
  },
  'POST /v1/establishments': {
    // CNPJ spoofing (teste 7): B tenta cadastrar na própria empresa o CNPJ de A.
    payload: ({ a }) => ({ cnpj: a.establishmentCnpj, tradeName: 'Spoof', municipalityCode: '2211001' }),
    expectCrossCompany: (res) => {
      expect(res.statusCode).toBe(422);
      expect(problemCode(res)).toBe('ESTABLISHMENT_ROOT_MISMATCH');
    },
  },
  'GET /v1/establishments': {
    expectCrossCompany: (res, { a, b }) => {
      expect(res.statusCode).toBe(200);
      const ids = res.json<{ items: { id: string }[] }>().items.map((e) => e.id);
      expect(ids).toContain(b.establishmentId);
      expect(ids).not.toContain(a.establishmentId);
    },
  },
  'GET /v1/establishments/:establishmentId': { expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND') },
  'POST /v1/establishments/:establishmentId/document-series': {
    payload: () => ({ kind: 'NFE', environment: 'HOMOLOGATION', series: '7' }),
    expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND'),
  },
  'GET /v1/establishments/:establishmentId/document-series': { expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND') },
  'POST /v1/establishments/:establishmentId/certificates': {
    payload: () => ({ pfx: DUMMY_PFX, password: 'senha-de-teste' }),
    expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND'),
  },
  'GET /v1/establishments/:establishmentId/certificates': { expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND') },
  'GET /v1/establishments/:establishmentId/certificates/:certificateId': { expectCrossCompany: expectNotFound('CERTIFICATE_NOT_FOUND') },
  'POST /v1/establishments/:establishmentId/certificates/:certificateId/revocation': { expectCrossCompany: expectNotFound('CERTIFICATE_NOT_FOUND') },
  'GET /v1/establishments/:establishmentId/production-enablements': { expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND') },
  'POST /v1/establishments/:establishmentId/production-enablements': {
    payload: ({ a }) => ({ kind: 'NFCE', confirmCnpj: a.establishmentCnpj }),
    expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND'),
  },
  'POST /v1/establishments/:establishmentId/production-enablements/:enablementId/revocation': {
    payload: () => ({ reason: 'tentativa de outra empresa' }),
    expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND'),
  },
  'POST /v1/service-invoices': {
    // B tenta emitir na própria empresa usando o estabelecimento de A.
    payload: ({ a }) => ({ establishmentId: a.establishmentId, ...sampleDpsData() }),
    headers: { 'idempotency-key': 'matriz-isolamento' },
    expectCrossCompany: expectNotFound('ESTABLISHMENT_NOT_FOUND'),
  },
  'GET /v1/service-invoices/:id': { expectCrossCompany: expectNotFound('SERVICE_INVOICE_NOT_FOUND') },
  'POST /v1/webhook-subscriptions': {
    payload: () => ({ url: 'http://127.0.0.1:9/matriz', eventTypes: ['certificate.activated'] }),
    expectCrossCompany: (res, { a }) => {
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(a.companyId);
    },
  },
  'GET /v1/webhook-subscriptions': {
    expectCrossCompany: (res, { a, b }) => {
      expect(res.statusCode).toBe(200);
      const ids = res.json<{ items: { id: string }[] }>().items.map((s) => s.id);
      expect(ids).toContain(b.subscriptionId);
      expect(ids).not.toContain(a.subscriptionId);
    },
  },
  'GET /v1/webhook-subscriptions/:subscriptionId': { expectCrossCompany: expectNotFound('WEBHOOK_SUBSCRIPTION_NOT_FOUND') },
  'PATCH /v1/webhook-subscriptions/:subscriptionId': {
    payload: () => ({ description: 'tentativa de outra empresa' }),
    expectCrossCompany: expectNotFound('WEBHOOK_SUBSCRIPTION_NOT_FOUND'),
  },
  'POST /v1/webhook-subscriptions/:subscriptionId/secret-rotation': { expectCrossCompany: expectNotFound('WEBHOOK_SUBSCRIPTION_NOT_FOUND') },
  'POST /v1/webhook-subscriptions/:subscriptionId/test': { expectCrossCompany: expectNotFound('WEBHOOK_SUBSCRIPTION_NOT_FOUND') },
  'GET /v1/webhook-deliveries': {
    expectCrossCompany: (res, { a, b }) => {
      expect(res.statusCode).toBe(200);
      const ids = res.json<{ items: { id: string }[] }>().items.map((d) => d.id);
      expect(ids).toContain(b.deliveryId);
      expect(ids).not.toContain(a.deliveryId);
    },
  },
  'GET /v1/webhook-deliveries/:deliveryId': { expectCrossCompany: expectNotFound('WEBHOOK_DELIVERY_NOT_FOUND') },
  'POST /v1/webhook-deliveries/:deliveryId/redeliver': { expectCrossCompany: expectNotFound('WEBHOOK_DELIVERY_NOT_FOUND') },
};

/** Rotas /v1 sem empresa, revisadas uma a uma. */
const NON_COMPANY_ROUTES = ['POST /v1/companies', 'GET /v1/webhook-event-types'];

const routeKey = (r: RouteCatalogEntry): string => `${r.method} ${r.url}`;
const isCompanyRoute = (r: RouteCatalogEntry): boolean => 'company' in r.auth && r.auth.company;

/** Rotas de empresa do catálogo sem caso na matriz. */
function missingCases(catalog: readonly RouteCatalogEntry[]): string[] {
  return catalog.filter((r) => r.method !== 'HEAD' && isCompanyRoute(r)).map(routeKey).filter((k) => !(k in CASES));
}

let t: TestApi;
let ctx: Ctx;
let superuser: DatabaseHandle;

function fill(url: string, party: Party): string {
  return url
    .replace(':establishmentId', party.establishmentId)
    .replace(':seriesId', party.seriesId)
    .replace(':certificateId', party.certificateId)
    .replace(':subscriptionId', party.subscriptionId)
    .replace(':deliveryId', party.deliveryId)
    .replace(':enablementId', party.enablementId)
    .replace(':id', party.invoiceId);
}

async function setupParty(prefix: string): Promise<Party> {
  const app = await createClientApp(t.admin, prefix);
  // `live`: as rotas de habilitação de produção exigem credencial live antes de olhar o recurso.
  const key = await app.key([...SCOPES], 'live');
  const company = await createCompany(t.app, key, fakeRoot());
  const establishmentCnpj = cnpjOf(company.root);
  const establishmentId = await createEstablishment(t.app, key, company.id, establishmentCnpj);
  const series = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/document-series`,
    headers: bearer(key, company.id),
    payload: { kind: 'NFCE', environment: 'HOMOLOGATION', series: '1' },
  });
  const certificate = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/certificates`,
    headers: bearer(key, company.id),
    payload: { pfx: DUMMY_PFX, password: 'senha-de-teste' },
  });
  const subscription = await t.app.inject({
    method: 'POST',
    url: '/v1/webhook-subscriptions',
    headers: bearer(key, company.id),
    payload: { url: 'http://127.0.0.1:9/hook', eventTypes: ['certificate.activated', 'certificate.rejected'] },
  });
  const subscriptionId = subscription.json<{ id: string }>().id;
  const delivery = await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${subscriptionId}/test`, headers: bearer(key, company.id) });
  // Habilitação real de A, gravada direto pelo superusuário (os pré-requisitos não são o assunto aqui).
  const enablementId = crypto.randomUUID();
  await new CompanyTransactions(superuser.db).run(company.id, (tx) =>
    tx.execute(sql`insert into production_enablements (id, company_id, establishment_id, kind) values (${enablementId}, ${company.id}, ${establishmentId}, 'NFCE')`),
  );
  // NFS-e de A (credencial live → produção): série de DPS de produção e habilitação NFSE_DPS.
  await new CompanyTransactions(superuser.db).run(company.id, (tx) =>
    tx.execute(sql`insert into production_enablements (id, company_id, establishment_id, kind) values (${crypto.randomUUID()}, ${company.id}, ${establishmentId}, 'NFSE_DPS')`),
  );
  const dpsSeries = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/document-series`,
    headers: bearer(key, company.id),
    payload: { kind: 'NFSE_DPS', environment: 'PRODUCTION', series: '1' },
  });
  expect(dpsSeries.statusCode).toBe(201);
  const invoice = await t.app.inject({
    method: 'POST',
    url: '/v1/service-invoices',
    headers: { ...bearer(key, company.id), 'idempotency-key': `matriz-${prefix}` },
    payload: { establishmentId, ...sampleDpsData() },
  });
  expect(invoice.statusCode, invoice.body).toBe(202);
  return {
    key,
    companyId: company.id,
    root: company.root,
    establishmentId,
    establishmentCnpj,
    seriesId: series.json<{ id: string }>().id,
    certificateId: certificate.json<{ id: string }>().id,
    subscriptionId,
    deliveryId: delivery.json<{ id: string }>().id,
    enablementId,
    invoiceId: invoice.json<{ id: string }>().id,
  };
}

beforeAll(async () => {
  t = await startTestApi();
  superuser = connect('superuser', { poolMax: 1 });
  ctx = { a: await setupParty('orbita'), b: await setupParty('nerp') };
});
afterAll(async () => {
  await superuser.close();
  await t.close();
});

const companyRoutes = (): RouteCatalogEntry[] => t.app.routeCatalog.filter((r) => r.method !== 'HEAD' && isCompanyRoute(r));

describe('Matriz de isolamento da API', () => {
  it('toda rota de empresa tem caso na matriz e todo caso é uma rota real', () => {
    expect(missingCases(t.app.routeCatalog)).toEqual([]);
    const keys = companyRoutes().map(routeKey);
    expect(Object.keys(CASES).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it('teste do teste: uma rota de empresa nova sem caso é detectada', () => {
    const fake: RouteCatalogEntry = { method: 'DELETE', url: '/v1/establishments/:establishmentId', auth: { scope: 'companies:manage', company: true } };
    expect(missingCases([...t.app.routeCatalog, fake])).toEqual(['DELETE /v1/establishments/:establishmentId']);
  });

  it('rotas /v1 sem empresa são só as revisadas', () => {
    const nonCompany = t.app.routeCatalog.filter((r) => r.method !== 'HEAD' && r.url.startsWith('/v1') && !isCompanyRoute(r)).map(routeKey);
    expect(nonCompany.sort()).toEqual([...NON_COMPANY_ROUTES].sort());
  });

  it('toda rota /v1 exige credencial (401 sem Authorization)', async () => {
    for (const route of t.app.routeCatalog.filter((r) => r.url.startsWith('/v1'))) {
      const res = await t.app.inject({ method: route.method as 'GET', url: fill(route.url, ctx.a), headers: { 'x-company-id': ctx.a.companyId } });
      expect(res.statusCode, routeKey(route)).toBe(401);
    }
  });

  it('aplicação sem concessão para a empresa → 403 COMPANY_ACCESS_DENIED em toda rota de empresa', async () => {
    for (const route of companyRoutes()) {
      const c = CASES[routeKey(route)];
      const res = await t.app.inject({
        method: route.method as 'GET',
        url: fill(route.url, ctx.a),
        headers: { ...bearer(ctx.b.key, ctx.a.companyId), ...c?.headers },
        ...(c?.payload ? { payload: c.payload(ctx) } : {}),
      });
      expect(res.statusCode, routeKey(route)).toBe(403);
      expect(problemCode(res), routeKey(route)).toBe('COMPANY_ACCESS_DENIED');
    }
  });

  it('na própria empresa, recursos e dados de outra empresa são invisíveis (404 / sem dados de A)', async () => {
    for (const route of companyRoutes()) {
      const c = CASES[routeKey(route)];
      if (c === undefined) throw new Error(`sem caso: ${routeKey(route)}`);
      const res = await t.app.inject({
        method: route.method as 'GET',
        url: fill(route.url, ctx.a),
        headers: { ...bearer(ctx.b.key, ctx.b.companyId), ...c.headers },
        ...(c.payload ? { payload: c.payload(ctx) } : {}),
      });
      c.expectCrossCompany(res, ctx);
    }
  });

  it('os dados de A continuam intactos depois das tentativas', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/establishments', headers: bearer(ctx.a.key, ctx.a.companyId) });
    expect(list.json<{ items: { id: string }[] }>().items.map((e) => e.id)).toEqual([ctx.a.establishmentId]);
    const series = await t.app.inject({
      method: 'GET',
      url: `/v1/establishments/${ctx.a.establishmentId}/document-series`,
      headers: bearer(ctx.a.key, ctx.a.companyId),
    });
    const seriesIds = series.json<{ items: { id: string }[] }>().items.map((s) => s.id);
    // A série de NF-e da matriz e a de DPS de produção da NFS-e de A; nenhuma criada por B.
    expect(seriesIds).toContain(ctx.a.seriesId);
    expect(seriesIds).toHaveLength(2);
    const invoice = await t.app.inject({ method: 'GET', url: `/v1/service-invoices/${ctx.a.invoiceId}`, headers: bearer(ctx.a.key, ctx.a.companyId) });
    expect(invoice.statusCode).toBe(200);
    expect(invoice.json<{ status: string; establishmentId: string }>()).toMatchObject({ status: 'PENDING', establishmentId: ctx.a.establishmentId });
  });
});
