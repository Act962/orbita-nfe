import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { translateDatabaseError } from '../../src/shared/infrastructure/database/database-errors.js';
import { expectNoCanary } from '../support/canary.js';
import { bearer, createClientApp, createCompany, problemCode, startTestApi, type ClientApp, type TestApi } from './support/api.js';
import { connect, newId } from './support/db.js';

/**
 * Autenticação por API key e autorização por escopo e concessão (ADR-0012, docs/architecture/14 §B3/§B4).
 */
let t: TestApi;
let owner: DatabaseHandle;
let orbita: ClientApp;
let manager: string;
let companyId: string;

beforeAll(async () => {
  t = await startTestApi();
  owner = connect('owner');
  orbita = await createClientApp(t.admin, 'orbita');
  manager = await orbita.key(['companies:create', 'companies:manage']);
  companyId = (await createCompany(t.app, manager)).id;
});

afterAll(async () => {
  await t.close();
  await owner.close();
});

const getCompany = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/v1/company', headers });

describe('Autenticação (401)', () => {
  it('sem credencial → 401 UNAUTHORIZED com WWW-Authenticate', async () => {
    const res = await getCompany({ 'x-company-id': companyId });
    expect(res.statusCode).toBe(401);
    expect(problemCode(res)).toBe('UNAUTHORIZED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['esquema errado', (k: string) => `Basic ${k}`],
    ['token malformado', () => 'Bearer fk_live_123'],
    ['token com espaço extra', (k: string) => `Bearer ${k} x`],
  ])('%s → 401', async (_, header) => {
    const res = await getCompany({ authorization: header(manager), 'x-company-id': companyId });
    expect(res.statusCode).toBe(401);
  });

  it('segredo errado com keyId válido → 401, mesma resposta de keyId inexistente', async () => {
    const wrongSecret = manager.slice(0, -4) + (manager.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const unknownKey = `fk_test_${'0'.repeat(16)}_${manager.slice(-43)}`;
    const a = await getCompany(bearer(wrongSecret, companyId));
    const b = await getCompany(bearer(unknownKey, companyId));
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json<{ detail: string }>().detail).toBe(b.json<{ detail: string }>().detail);
  });

  it('trocar o ambiente no prefixo (test → live) invalida a chave', async () => {
    const res = await getCompany(bearer(manager.replace('fk_test_', 'fk_live_'), companyId));
    expect(res.statusCode).toBe(401);
  });

  it('chave revogada → 401 na requisição seguinte', async () => {
    const key = await orbita.key(['companies:read']);
    expect((await getCompany(bearer(key, companyId))).statusCode).toBe(200);
    await t.admin.revokeCredential(key.split('_')[2] ?? '');
    expect((await getCompany(bearer(key, companyId))).statusCode).toBe(401);
  });

  it('chave expirada → 401', async () => {
    const key = await orbita.key(['companies:read']);
    await owner.db.execute(sql`update credentials set expires_at = now() - interval '1 second' where key_id = ${key.split('_')[2]}`);
    expect((await getCompany(bearer(key, companyId))).statusCode).toBe(401);
  });

  it('aplicação desativada → todas as suas chaves param', async () => {
    const app = await createClientApp(t.admin, 'desativada');
    const key = await app.key(['companies:create']);
    await owner.db.execute(sql`update client_applications set status = 'DISABLED' where id = ${app.id}`);
    const res = await t.app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(key), payload: { legalName: 'X', rootCnpj: '11111111' } });
    expect(res.statusCode).toBe(401);
  });

  it('não autenticado não recebe detalhes de validação (401 antes de 400)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/companies', payload: { legalName: 123 } });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('legalName');
  });
});

describe('Autorização (403)', () => {
  it('sem o escopo → 403 INSUFFICIENT_SCOPE', async () => {
    const readOnly = await orbita.key(['companies:read']);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers: bearer(readOnly, companyId),
      payload: { cnpj: '00000000000000', tradeName: 'X', municipalityCode: '2211001' },
    });
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('INSUFFICIENT_SCOPE');
  });

  it(':manage implica :read', async () => {
    expect((await getCompany(bearer(manager, companyId))).statusCode).toBe(200);
  });

  it('X-Company-Id ausente ou inválido → 400 no header (depois de autenticar)', async () => {
    const missing = await getCompany(bearer(manager));
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ field: 'headers.x-company-id', code: 'REQUIRED' }] });
    const invalid = await getCompany(bearer(manager, 'nao-e-uuid'));
    expect(invalid.json()).toMatchObject({ issues: [{ field: 'headers.x-company-id', code: 'INVALID_FORMAT' }] });
  });

  it('empresa sem concessão e empresa inexistente → mesma resposta 403 COMPANY_ACCESS_DENIED', async () => {
    const other = await createClientApp(t.admin, 'nerp');
    const nerpKey = await other.key(['companies:read']);
    const noGrant = await getCompany(bearer(nerpKey, companyId));
    const missing = await getCompany(bearer(nerpKey, newId()));
    expect([noGrant.statusCode, missing.statusCode]).toEqual([403, 403]);
    expect(problemCode(noGrant)).toBe('COMPANY_ACCESS_DENIED');
    expect(noGrant.json<{ detail: string }>().detail).toBe(missing.json<{ detail: string }>().detail);
  });

  it('concessão dada pelo operador libera; revogada bloqueia na requisição seguinte (sem cache)', async () => {
    const other = await createClientApp(t.admin, 'nerp');
    const key = await other.key(['companies:read']);
    await t.admin.grantCompany(other.id, companyId);
    expect((await getCompany(bearer(key, companyId))).statusCode).toBe(200);
    await t.admin.revokeCompanyGrant(other.id, companyId);
    expect(problemCode(await getCompany(bearer(key, companyId)))).toBe('COMPANY_ACCESS_DENIED');
    await t.admin.grantCompany(other.id, companyId);
    expect((await getCompany(bearer(key, companyId))).statusCode).toBe(200);
  });

  it('empresa suspensa → 403 COMPANY_SUSPENDED', async () => {
    const suspended = (await createCompany(t.app, manager)).id;
    await new CompanyTransactions(owner.db).run(suspended, (tx) => tx.execute(sql`update companies set status = 'SUSPENDED' where id = ${suspended}`));
    expect(problemCode(await getCompany(bearer(manager, suspended)))).toBe('COMPANY_SUSPENDED');
  });
});

describe('Credenciais no banco e nos logs', () => {
  it('o banco guarda só o HMAC (32 bytes), nunca o segredo', async () => {
    const key = await orbita.key(['companies:read']);
    const [, , keyId, ...secretParts] = key.split('_');
    const secret = secretParts.join('_');
    const rows = await owner.db.execute<{ secret_hash: Buffer }>(sql`select secret_hash from credentials where key_id = ${keyId}`);
    const hash = rows.rows[0]?.secret_hash;
    expect(hash).toHaveLength(32);
    expect(hash?.toString('utf8')).not.toContain(secret);
    expect(hash?.toString('base64url')).not.toBe(secret);
  });

  it('a API key não aparece nos logs nem nas respostas', async () => {
    const key = await orbita.key(['companies:read']);
    const secret = key.slice(-43);
    await getCompany(bearer(key, companyId));
    await getCompany(bearer(`${key}x`, companyId));
    expect(t.logs.text()).not.toContain(secret);
    expectNoCanary(t.logs.text());
  });

  it('o papel da API não escreve credenciais nem aplicações (só o operador)', async () => {
    const attempt = t.api.db.execute(sql`insert into client_applications (id, name) values (${newId()}, 'invasora')`);
    const error = await attempt.then(() => undefined, (e: unknown) => e);
    expect(translateDatabaseError(error).code).toBe('DATABASE_ACCESS_VIOLATION');
    const update = await t.api.db.execute(sql`update credentials set scopes = '{companies:create}'`).then(() => undefined, (e: unknown) => e);
    expect(translateDatabaseError(update).code).toBe('DATABASE_ACCESS_VIOLATION');
  });
});
