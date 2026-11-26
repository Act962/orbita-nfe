import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyTransactions } from '../../src/shared/infrastructure/database/database.js';
import { connect } from './support/db.js';
import { bearer, cnpjOf, createClientApp, createCompany, fakeRoot, problemCode, startTestApi, type TestApi } from './support/api.js';

/** Cadastro de companies e estabelecimentos pela API (docs/architecture/02 §2). */
let t: TestApi;
let key: string;
let appId: string;

beforeAll(async () => {
  t = await startTestApi();
  const app = await createClientApp(t.admin, 'orbita');
  appId = app.id;
  key = await app.key(['companies:create', 'companies:manage']);
});
afterAll(async () => {
  await t.close();
});

describe('POST /v1/companies', () => {
  it('cria a empresa com id do servidor e concede acesso à aplicação criadora, na mesma transação', async () => {
    const root = fakeRoot();
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/companies',
      headers: bearer(key),
      payload: { legalName: ' Empresa  Fictícia LTDA ', rootCnpj: root, id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string }>();
    expect(body).toMatchObject({ legalName: 'Empresa Fictícia LTDA', rootCnpj: root, status: 'ACTIVE' });
    expect(body.id).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    const grants = await new CompanyTransactions(t.api.db).run(body.id, (tx) =>
      tx.execute<{ status: string }>(sql`select status from company_grants where client_application_id = ${appId}`),
    );
    expect(grants.rows).toEqual([{ status: 'ACTIVE' }]);
  });

  it('raiz já cadastrada → 409 COMPANY_ALREADY_REGISTERED (sem eco do valor)', async () => {
    const { root } = await createCompany(t.app, key);
    const res = await t.app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(key), payload: { legalName: 'Outra', rootCnpj: root } });
    expect(res.statusCode).toBe(409);
    expect(problemCode(res)).toBe('COMPANY_ALREADY_REGISTERED');
    expect(res.body).not.toContain(root);
  });

  it('raiz inválida → 400 com campo body.rootCnpj e regra CNPJ-001', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(key), payload: { legalName: 'X', rootCnpj: '1234-567' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ field: 'body.rootCnpj', code: 'CNPJ_INVALID_ROOT', ruleId: 'CNPJ-001' }] });
  });
});

describe('Estabelecimentos', () => {
  it('cadastra, consulta e lista', async () => {
    const company = await createCompany(t.app, key);
    const cnpj = cnpjOf(company.root, '0001');
    const masked = `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers: bearer(key, company.id),
      payload: { cnpj: masked, tradeName: 'Matriz Teresina', municipalityCode: '2211001' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(created.headers.location).toBe(`/v1/establishments/${id}`);
    expect(created.json()).toMatchObject({ cnpj, tradeName: 'Matriz Teresina', status: 'ACTIVE' });

    const one = await t.app.inject({ method: 'GET', url: `/v1/establishments/${id}`, headers: bearer(key, company.id) });
    expect(one.json()).toMatchObject({ id, cnpj });
    const list = await t.app.inject({ method: 'GET', url: '/v1/establishments', headers: bearer(key, company.id) });
    expect(list.json<{ items: { id: string }[] }>().items.map((e) => e.id)).toEqual([id]);
  });

  it('inscrição municipal (ADR-0061): opcional no cadastro, alterada e apagada pelo PATCH, auditada', async () => {
    const company = await createCompany(t.app, key);
    const headers = bearer(key, company.id);
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers,
      payload: { cnpj: cnpjOf(company.root, '0001'), tradeName: 'Matriz', municipalityCode: '2211001', municipalRegistration: ' 123456 ' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ municipalRegistration: '123456' });

    const patch = (municipalRegistration: unknown) =>
      t.app.inject({ method: 'PATCH', url: `/v1/establishments/${id}`, headers, payload: { municipalRegistration } });
    expect((await patch('IM-2026')).json()).toMatchObject({ id, municipalRegistration: 'IM-2026' });
    expect((await patch(null)).json()).toMatchObject({ id, municipalRegistration: null });
    const tooLong = await patch('1234567890123456');
    expect(tooLong.statusCode).toBe(400);
    expect(problemCode(tooLong)).toBe('VALIDATION_FAILED');
    expect((await patch('   ')).statusCode).toBe(400);
    // Só a IM pode ser alterada por esta rota.
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/establishments/${id}`, headers, payload: { municipalRegistration: '1', tradeName: 'X' } })).statusCode).toBe(400);

    // A API não lê a auditoria (só grava); a conferência usa o papel de superusuário dos testes.
    const superuser = connect('superuser');
    const audit = await superuser.db.transaction(async (tx) =>
      tx.execute<{ action: string }>(sql`select action from audit_log where subject_id = ${id} order by sequence`),
    );
    await superuser.close();
    expect(audit.rows.map((r) => r.action)).toEqual(['establishment.registered', 'establishment.municipal_registration_changed', 'establishment.municipal_registration_changed']);
  });

  it('perfil estadual (ADR-0071): gravado, normalizado, recusado fora do XSD, apagado e auditado', async () => {
    const company = await createCompany(t.app, key);
    const headers = bearer(key, company.id);
    const created = await t.app.inject({ method: 'POST', url: '/v1/establishments', headers, payload: { cnpj: cnpjOf(company.root, '0001'), tradeName: 'Loja', municipalityCode: '2211001' } });
    const id = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({ stateProfile: null });

    const url = `/v1/establishments/${id}/state-profile`;
    const profile = { stateRegistration: '123456789', taxRegime: '1', address: { street: ' RUA TESTE ', number: '100', district: 'CENTRO', postalCode: '64000-000', phone: '(86) 3222-0000' } };
    const put = await t.app.inject({ method: 'PUT', url, headers, payload: profile });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      stateProfile: { stateRegistration: '123456789', taxRegime: '1', address: { street: 'RUA TESTE', number: '100', complement: null, district: 'CENTRO', postalCode: '64000000', phone: '8632220000' } },
    });
    expect((await t.app.inject({ method: 'GET', url: `/v1/establishments/${id}`, headers })).json()).toMatchObject({ stateProfile: { stateRegistration: '123456789' } });

    // Formatos do XSD (TIe, CRT, CEP); o motor não completa nem deduz nada.
    const bad = await t.app.inject({ method: 'PUT', url, headers, payload: { ...profile, stateRegistration: '12.345.678-9', taxRegime: '5', address: { ...profile.address, postalCode: '640' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ issues: { field: string }[] }>().issues.map((i) => i.field).sort()).toEqual(['body.address.postalCode', 'body.stateRegistration', 'body.taxRegime']);
    expect((await t.app.inject({ method: 'PUT', url, headers, payload: { ...profile, extra: 1 } })).statusCode).toBe(400);

    // Repetir o mesmo perfil não gera auditoria; apagar volta a null.
    expect((await t.app.inject({ method: 'PUT', url, headers, payload: profile })).statusCode).toBe(200);
    const removed = await t.app.inject({ method: 'DELETE', url, headers });
    expect(removed.json()).toMatchObject({ stateProfile: null });

    const superuser = connect('superuser');
    const audit = await superuser.db.transaction(async (tx) =>
      tx.execute<{ action: string }>(sql`select action from audit_log where subject_id = ${id} order by sequence`),
    );
    // O banco recusa perfil pela metade, mesmo fora da API.
    const partial = await superuser.db
      .transaction(async (tx) => tx.execute(sql`update establishments set state_registration = '123' where id = ${id}`))
      .then(
        () => 'aceitou',
        (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint,
      );
    expect(partial).toBe('ck_establishments_state_profile_complete');
    await superuser.close();
    expect(audit.rows.map((r) => r.action)).toEqual(['establishment.registered', 'establishment.state_profile_changed', 'establishment.state_profile_changed']);
  });

  it('COMPANY-001: CNPJ de outra raiz → 422 com campo body.cnpj', async () => {
    const company = await createCompany(t.app, key);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers: bearer(key, company.id),
      payload: { cnpj: cnpjOf(fakeRoot()), tradeName: 'X', municipalityCode: '2211001' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'ESTABLISHMENT_ROOT_MISMATCH', issues: [{ field: 'body.cnpj', ruleId: 'COMPANY-001' }] });
  });

  it('DV inválido → 400 CNPJ_INVALID_CHECK_DIGITS em body.cnpj', async () => {
    const company = await createCompany(t.app, key);
    const valid = cnpjOf(company.root);
    const wrong = valid.slice(0, 12) + (valid.endsWith('00') ? '11' : '00');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers: bearer(key, company.id),
      payload: { cnpj: wrong, tradeName: 'X', municipalityCode: '2211001' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ issues: [{ field: 'body.cnpj', code: 'CNPJ_INVALID_CHECK_DIGITS', ruleId: 'CNPJ-001' }] });
  });

  it('CNPJ já cadastrado → 409 ESTABLISHMENT_ALREADY_REGISTERED', async () => {
    const company = await createCompany(t.app, key);
    const payload = { cnpj: cnpjOf(company.root), tradeName: 'X', municipalityCode: '2211001' };
    const headers = bearer(key, company.id);
    expect((await t.app.inject({ method: 'POST', url: '/v1/establishments', headers, payload })).statusCode).toBe(201);
    const dup = await t.app.inject({ method: 'POST', url: '/v1/establishments', headers, payload });
    expect(dup.statusCode).toBe(409);
    expect(problemCode(dup)).toBe('ESTABLISHMENT_ALREADY_REGISTERED');
  });

  it('id inexistente → 404 ESTABLISHMENT_NOT_FOUND; id malformado → 400', async () => {
    const company = await createCompany(t.app, key);
    const missing = await t.app.inject({ method: 'GET', url: '/v1/establishments/0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20', headers: bearer(key, company.id) });
    expect(missing.statusCode).toBe(404);
    expect(problemCode(missing)).toBe('ESTABLISHMENT_NOT_FOUND');
    const malformed = await t.app.inject({ method: 'GET', url: '/v1/establishments/abc', headers: bearer(key, company.id) });
    expect(malformed.json()).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ field: 'params.establishmentId' }] });
  });
});
