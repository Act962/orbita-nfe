import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationError } from '../../src/shared/application/errors.js';
import { translateDatabaseError } from '../../src/shared/infrastructure/database/database-errors.js';
import { createClientApp, createCompany, startTestApi, uniqueName, type TestApi } from './support/api.js';
import { newId } from './support/db.js';

/** Casos de uso do operador (CLI) com o papel fiscal_admin. */
let t: TestApi;
beforeAll(async () => {
  t = await startTestApi();
});
afterAll(async () => {
  await t.close();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof ApplicationError)) throw new Error('esperava ApplicationError');
  return error.code;
}

describe('IamAdmin', () => {
  it('nome de aplicação duplicado → CLIENT_APPLICATION_ALREADY_EXISTS', async () => {
    const name = uniqueName('dup');
    await t.admin.createClientApplication(name);
    expect(await codeOf(t.admin.createClientApplication(name))).toBe('CLIENT_APPLICATION_ALREADY_EXISTS');
  });

  it('escopo fora do catálogo, lista vazia e expiração passada → VALIDATION_FAILED', async () => {
    const app = await createClientApp(t.admin);
    expect(await codeOf(t.admin.issueCredential({ clientApplicationId: app.id, environment: 'live', scopes: ['companies:*'] }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(t.admin.issueCredential({ clientApplicationId: app.id, environment: 'live', scopes: [] }))).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(t.admin.issueCredential({ clientApplicationId: app.id, environment: 'live', scopes: ['nfse:read'], expiresAt: new Date(0) })),
    ).toBe('VALIDATION_FAILED');
  });

  it('aplicação, empresa, credencial ou concessão inexistentes → NOT_FOUND específico', async () => {
    const app = await createClientApp(t.admin);
    expect(await codeOf(t.admin.issueCredential({ clientApplicationId: newId(), environment: 'test', scopes: ['nfse:read'] }))).toBe(
      'CLIENT_APPLICATION_NOT_FOUND',
    );
    expect(await codeOf(t.admin.grantCompany(app.id, newId()))).toBe('COMPANY_NOT_FOUND');
    expect(await codeOf(t.admin.revokeCredential('ffffffffffffffff'))).toBe('CREDENTIAL_NOT_FOUND');
    expect(await codeOf(t.admin.revokeCompanyGrant(app.id, newId()))).toBe('COMPANY_GRANT_NOT_FOUND');
    expect(await codeOf(t.admin.grantCompany('nao-uuid', newId()))).toBe('VALIDATION_FAILED');
  });

  it('a credencial emitida tem o formato fk_<env>_<keyId>_<segredo>', async () => {
    const app = await createClientApp(t.admin);
    const issued = await t.admin.issueCredential({ clientApplicationId: app.id, environment: 'live', scopes: ['nfse:read', 'nfse:read'] });
    expect(issued.token).toMatch(new RegExp(`^fk_live_${issued.keyId}_[A-Za-z0-9_-]{43}$`));
    const rows = await t.adminDb.db.execute<{ scopes: string[] }>(sql`select scopes from credentials where id = ${issued.id}`);
    expect(rows.rows[0]?.scopes).toEqual(['nfse:read']);
  });

  it('o operador não lê dados fiscais (estabelecimentos) nem apaga credenciais', async () => {
    const app = await createClientApp(t.admin);
    const key = await app.key(['companies:create']);
    await createCompany(t.app, key);
    const read = await t.adminDb.db.execute(sql`select * from establishments`).then(() => undefined, (e: unknown) => e);
    expect(translateDatabaseError(read).code).toBe('DATABASE_ACCESS_VIOLATION');
    const del = await t.adminDb.db.execute(sql`delete from credentials`).then(() => undefined, (e: unknown) => e);
    expect(translateDatabaseError(del).code).toBe('DATABASE_ACCESS_VIOLATION');
  });
});
