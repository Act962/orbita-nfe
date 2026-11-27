import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAcceptableNumericCode } from '../../src/modules/nfce/domain/access-key.js';
import { CompanyTransactions } from '../../src/shared/infrastructure/database/database.js';
import { MINIMAL_SALE } from '../support/nfce-fixtures.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, problemCode, startTestApi, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Aceite da NFC-e pela API (ADR-0072, fatia 2). Venda e cadastro FICTÍCIOS; nada é transmitido
 * (o job `nfce.process` fica na fila até o worker da NFC-e existir).
 */
let t: TestApi;
let key: string;
let otherAppKey: string;
let debugKey: string;
let companyId: string;
let establishmentId: string;
let bareEstablishmentId: string;

const PROFILE = { stateRegistration: '123456789', taxRegime: '1', address: { street: 'RUA TESTE', number: '100', district: 'CENTRO', postalCode: '64000000' } };

const post = (body: unknown, idempotencyKey: string, credential = key) =>
  t.app.inject({ method: 'POST', url: '/v1/consumer-invoices', headers: { ...bearer(credential, companyId), 'idempotency-key': idempotencyKey }, payload: body as object });

async function setupEstablishment(branch: string, profile: unknown): Promise<string> {
  const company = await t.app.inject({ method: 'GET', url: '/v1/company', headers: bearer(key, companyId) });
  const root = company.json<{ rootCnpj: string }>().rootCnpj;
  const id = await createEstablishment(t.app, key, companyId, cnpjOf(root, branch));
  if (profile !== null) {
    const res = await t.app.inject({ method: 'PUT', url: `/v1/establishments/${id}/state-profile`, headers: bearer(key, companyId), payload: profile as object });
    expect(res.statusCode, res.body).toBe(200);
  }
  const series = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${id}/document-series`,
    headers: bearer(key, companyId),
    payload: { kind: 'NFCE', environment: 'HOMOLOGATION', series: '1' },
  });
  expect(series.statusCode, series.body).toBe(201);
  return id;
}

beforeAll(async () => {
  t = await startTestApi();
  const app = await createClientApp(t.admin, 'nfce-api');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'nfce:issue', 'nfce:read']);
  // Mesma aplicação, credencial só com o diagnóstico (ADR-0078).
  debugKey = await app.key(['nfce:debug']);
  const other = await createClientApp(t.admin, 'nfce-outra');
  otherAppKey = await other.key(['nfce:issue', 'nfce:read']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  // A outra aplicação recebe acesso à mesma empresa: só não enxerga as notas da primeira.
  await t.admin.grantCompany(other.id, companyId);
  establishmentId = await setupEstablishment('0001', PROFILE);
  bareEstablishmentId = await setupEstablishment('0002', null);
});

afterAll(async () => {
  await t.close();
});

describe('POST /v1/consumer-invoices', () => {
  it('aceita a venda: 202 PENDING, número da série, cNF pela regra B03-10, auditoria e job nfce.process', async () => {
    const res = await post({ establishmentId, externalReference: 'venda-1', ...MINIMAL_SALE }, 'nfce-1');
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json<{ id: string; number: number }>();
    expect(body).toMatchObject({ status: 'PENDING', series: '1', number: 1, environment: 'HOMOLOGATION', externalReference: 'venda-1', accessKey: null, authorizer: null });
    expect(res.headers.location).toBe(`/v1/consumer-invoices/${body.id}`);

    const superuser = connect('superuser');
    const row = await new CompanyTransactions(superuser.db).run(companyId, async (tx) => ({
      invoice: (await tx.execute<{ numeric_code: string; payload: unknown }>(sql`select numeric_code, payload from consumer_invoices where id = ${body.id}`)).rows[0],
      jobs: (await tx.execute<{ queue: string }>(sql`select queue from jobs where payload->>'invoiceId' = ${body.id}`)).rows,
      audit: (await tx.execute<{ action: string }>(sql`select action from audit_log where subject_id = ${body.id}`)).rows,
    }));
    await superuser.close();
    expect(isAcceptableNumericCode(row.invoice?.numeric_code ?? '', body.number)).toBe(true);
    expect(row.invoice?.payload).toMatchObject({ operationNature: 'VENDA', items: [{ cfop: '5102' }] });
    expect(row.jobs.map((j) => j.queue)).toEqual(['nfce.process']);
    expect(row.audit.map((a) => a.action)).toEqual(['consumer_invoice.accepted']);
  });

  it('repetição: mesma chave e corpo → 200 com a mesma nota; mesma chave e outro corpo → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const body = { establishmentId, ...MINIMAL_SALE };
    const first = await post(body, 'nfce-repete');
    const again = await post(body, 'nfce-repete');
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const reused = await post({ ...body, operationNature: 'OUTRA' }, 'nfce-repete');
    expect(reused.statusCode).toBe(422);
    expect(problemCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('regras oficiais: CFOP fora da lista do CSOSN → 422 NFCE_RULES_VIOLATED com a regra e o campo', async () => {
    const res = await post({ establishmentId, ...MINIMAL_SALE, items: [{ ...MINIMAL_SALE.items[0], cfop: '5405' }] }, 'nfce-cfop');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'NFCE_RULES_VIOLATED', issues: [{ code: 'NFCE_CFOP_NOT_ALLOWED_FOR_CSOSN', ruleId: 'N12a-40', field: 'body.items[0].cfop' }] });
  });

  it('forma do XSD e campos fora do contrato → 400', async () => {
    expect((await post({ establishmentId, ...MINIMAL_SALE, items: [{ ...MINIMAL_SALE.items[0], amount: '7.9' }] }, 'nfce-400a')).statusCode).toBe(400);
    expect((await post({ establishmentId, ...MINIMAL_SALE, delivery: {} }, 'nfce-400b')).statusCode).toBe(400);
  });

  it('estabelecimento sem perfil estadual → 422 NFCE_STATE_PROFILE_REQUIRED; fora do Simples → regra da v1', async () => {
    const res = await post({ establishmentId: bareEstablishmentId, ...MINIMAL_SALE }, 'nfce-sem-perfil');
    expect(res.statusCode).toBe(422);
    expect(problemCode(res)).toBe('NFCE_STATE_PROFILE_REQUIRED');

    const normal = await setupEstablishment('0003', { ...PROFILE, taxRegime: '3' });
    const regime = await post({ establishmentId: normal, ...MINIMAL_SALE }, 'nfce-regime');
    expect(regime.json()).toMatchObject({ code: 'NFCE_RULES_VIOLATED', issues: [{ code: 'NFCE_REGIME_NOT_SUPPORTED' }] });
  });

  it('referência externa ocupada → 409 DOCUMENT_IN_PROGRESS; a consulta pela referência acha a nota', async () => {
    const first = await post({ establishmentId, externalReference: 'venda-ref', ...MINIMAL_SALE }, 'nfce-ref-1');
    const second = await post({ establishmentId, externalReference: 'venda-ref', ...MINIMAL_SALE }, 'nfce-ref-2');
    expect(second.statusCode).toBe(409);
    expect(problemCode(second)).toBe('DOCUMENT_IN_PROGRESS');
    const list = await t.app.inject({ method: 'GET', url: '/v1/consumer-invoices?externalReference=venda-ref', headers: bearer(key, companyId) });
    expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([first.json<{ id: string }>().id]);
  });

  it('credencial live sem habilitação de produção → 403 PRODUCTION_NOT_ENABLED', async () => {
    const app = await createClientApp(t.admin, 'nfce-live');
    const live = await app.key(['nfce:issue'], 'live');
    await t.admin.grantCompany(app.id, companyId);
    const res = await post({ establishmentId, ...MINIMAL_SALE }, 'nfce-live', live);
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('PRODUCTION_NOT_ENABLED');
  });
});

describe('POST /v1/consumer-invoices/validation (ADR-0077)', () => {
  const validate = (body: unknown, credential = key) =>
    t.app.inject({ method: 'POST', url: '/v1/consumer-invoices/validation', headers: bearer(credential, companyId), payload: body as object });

  it('venda válida → 200 com a série, sem numerar, gravar nem enfileirar', async () => {
    const superuser = connect('superuser');
    const count = async () =>
      new CompanyTransactions(superuser.db).run(companyId, async (tx) => ({
        invoices: Number((await tx.execute<{ n: string }>(sql`select count(*) as n from consumer_invoices`)).rows[0]?.n),
        jobs: Number((await tx.execute<{ n: string }>(sql`select count(*) as n from jobs where queue = 'nfce.process'`)).rows[0]?.n),
        audit: Number((await tx.execute<{ n: string }>(sql`select count(*) as n from audit_log`)).rows[0]?.n),
        next: (await tx.execute<{ next_number: string }>(sql`select next_number from document_series where establishment_id = ${establishmentId} and kind = 'NFCE'`)).rows[0]?.next_number,
      }));
    const before = await count();
    const res = await validate({ establishmentId, externalReference: 'so-validar', ...MINIMAL_SALE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, environment: 'HOMOLOGATION', series: { series: '1' } });
    expect(await count()).toEqual(before);
    await superuser.close();
  });

  it('os mesmos erros da emissão: regras oficiais (422), perfil estadual (422), forma (400), referência ocupada (409)', async () => {
    const cfop = await validate({ establishmentId, ...MINIMAL_SALE, items: [{ ...MINIMAL_SALE.items[0], cfop: '5405' }] });
    expect(cfop.json()).toMatchObject({ code: 'NFCE_RULES_VIOLATED', issues: [{ ruleId: 'N12a-40', field: 'body.items[0].cfop' }] });
    expect(problemCode(await validate({ establishmentId: bareEstablishmentId, ...MINIMAL_SALE }))).toBe('NFCE_STATE_PROFILE_REQUIRED');
    expect((await validate({ establishmentId, ...MINIMAL_SALE, delivery: {} })).statusCode).toBe(400);
    await post({ establishmentId, externalReference: 'validar-ocupada', ...MINIMAL_SALE }, 'nfce-validar-ocupada');
    const occupied = await validate({ establishmentId, externalReference: 'validar-ocupada', ...MINIMAL_SALE });
    expect(occupied.statusCode).toBe(409);
    expect(problemCode(occupied)).toBe('DOCUMENT_IN_PROGRESS');
  });
});

describe('Prefer: wait na emissão (ADR-0077)', () => {
  it('sem worker, a nota segue PENDING: 202 depois da espera, com Preference-Applied', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/consumer-invoices',
      headers: { ...bearer(key, companyId), 'idempotency-key': 'nfce-wait', prefer: 'wait=1' },
      payload: { establishmentId, ...MINIMAL_SALE },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.headers['preference-applied']).toBe('wait=1');
    expect(res.json()).toMatchObject({ status: 'PENDING' });
  });
});

describe('GET /v1/consumer-invoices/:id/diagnostics (ADR-0078)', () => {
  it('exige nfce:debug (nfce:read não basta); com o escopo, nota sem tentativa ainda', async () => {
    const created = await post({ establishmentId, ...MINIMAL_SALE }, 'nfce-diag');
    const id = created.json<{ id: string }>().id;
    const denied = await t.app.inject({ method: 'GET', url: `/v1/consumer-invoices/${id}/diagnostics`, headers: bearer(key, companyId) });
    expect(denied.statusCode).toBe(403);
    const own = await t.app.inject({ method: 'GET', url: `/v1/consumer-invoices/${id}/diagnostics`, headers: bearer(debugKey, companyId) });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({
      consumerInvoiceId: id,
      status: 'PENDING',
      protocol: { accessKey: null, authorizerStatusCode: null, protocolNumber: null, nfeProcSha256: null, archivedAt: null, retainUntil: null },
      attempts: [],
    });
    const otherApp = await createClientApp(t.admin, 'nfce-debug-outra');
    const otherDebugKey = await otherApp.key(['nfce:debug']);
    await t.admin.grantCompany(otherApp.id, companyId);
    // A nota é da primeira aplicação: outra, mesmo com o escopo, não a enxerga.
    const other = await t.app.inject({ method: 'GET', url: `/v1/consumer-invoices/${id}/diagnostics`, headers: bearer(otherDebugKey, companyId) });
    expect(problemCode(other)).toBe('CONSUMER_INVOICE_NOT_FOUND');
  });
});

describe('GET /v1/consumer-invoices/:id', () => {
  it('a própria aplicação consulta; outra aplicação da mesma empresa recebe 404', async () => {
    const created = await post({ establishmentId, ...MINIMAL_SALE }, 'nfce-get');
    const id = created.json<{ id: string }>().id;
    const own = await t.app.inject({ method: 'GET', url: `/v1/consumer-invoices/${id}`, headers: bearer(key, companyId) });
    expect(own.json()).toMatchObject({ id, status: 'PENDING', links: { self: `/v1/consumer-invoices/${id}` } });
    const other = await t.app.inject({ method: 'GET', url: `/v1/consumer-invoices/${id}`, headers: bearer(otherAppKey, companyId) });
    expect(other.statusCode).toBe(404);
    expect(problemCode(other)).toBe('CONSUMER_INVOICE_NOT_FOUND');
  });
});
