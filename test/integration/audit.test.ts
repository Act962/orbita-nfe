import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeAuditVerifier } from '../../src/main/compose.js';
import type { AuditVerifier } from '../../src/modules/audit/public.js';
import type { DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/** Trilha de auditoria append-only com hash encadeado (docs/architecture/14 §A4). */
let t: TestApi;
let verifier: AuditVerifier;
let owner: DatabaseHandle;
let superuser: DatabaseHandle;
let key: string;
let companyId: string;
let root: string;

async function inCompany<T>(handle: DatabaseHandle, id: string, query: ReturnType<typeof sql>) {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${id}, true)`);
    return tx.execute<T & Record<string, unknown>>(query);
  });
}

beforeAll(async () => {
  t = await startTestApi();
  verifier = composeAuditVerifier({ db: t.adminDb.db });
  owner = connect('owner', { poolMax: 1 });
  superuser = connect('superuser', { poolMax: 1 });
  const app = await createClientApp(t.admin, 'audit');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
});

afterAll(async () => {
  await owner.close();
  await superuser.close();
  await t.close();
});

describe('registro na mesma transação da mudança', () => {
  it('criação de empresa grava empresa + concessão, com ator e correlation id', async () => {
    const rows = await inCompany<{ action: string; actor_kind: string; correlation_id: string | null }>(
      t.adminDb,
      companyId,
      sql`select action, actor_kind, correlation_id from audit_log order by sequence`,
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['company.registered', 'company_grant.granted']);
    expect(rows.rows.every((r) => r.actor_kind === 'CLIENT_APPLICATION' && r.correlation_id !== null)).toBe(true);
  });

  it('operação rejeitada não deixa registro (rollback junto)', async () => {
    const before = await verifier.verify({ kind: 'COMPANY', companyId });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments',
      headers: bearer(key, companyId),
      payload: { cnpj: cnpjOf('99887766'), tradeName: 'X', municipalityCode: '2211001' },
    });
    expect(res.statusCode).toBe(422);
    const after = await verifier.verify({ kind: 'COMPANY', companyId });
    expect(after).toEqual(before);
  });

  it('escritas concorrentes na mesma empresa mantêm a cadeia íntegra e sem buracos', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createEstablishment(t.app, key, companyId, cnpjOf(root, String(100 + i).padStart(4, '0')))),
    );
    expect(results).toHaveLength(12);
    const verification = await verifier.verify({ kind: 'COMPANY', companyId });
    expect(verification).toMatchObject({ ok: true });
    expect(verification.ok && verification.entries).toBeGreaterThanOrEqual(14);
  });

  it('operador: concessão vai para a cadeia da empresa; aplicação e credencial, para a da plataforma', async () => {
    const other = await createClientApp(t.admin, 'audit-op');
    await t.admin.grantCompany(other.id, companyId);
    const rows = await inCompany<{ action: string; actor_id: string }>(
      t.adminDb,
      companyId,
      sql`select action, actor_id from audit_log where actor_kind = 'OPERATOR'`,
    );
    expect(rows.rows).toEqual([{ action: 'company_grant.granted', actor_id: 'teste-automatizado' }]);
    const platform = await t.adminDb.db.execute<{ action: string }>(sql`select action from platform_audit_log where subject_id = ${other.id}`);
    expect(platform.rows.map((r) => r.action)).toEqual(['client_application.created']);
    expect(await verifier.verify({ kind: 'PLATFORM' })).toMatchObject({ ok: true });
  });
});

describe('append-only e encadeamento no banco', () => {
  it('ninguém altera nem apaga registro, nem o dono das tabelas', async () => {
    for (const statement of [sql`update audit_log set action = 'x'`, sql`delete from audit_log`]) {
      await expect(inCompany(owner, companyId, statement)).rejects.toMatchObject({ cause: { constraint: 'ck_audit_append_only' } });
    }
    await expect(owner.db.execute(sql`truncate audit_log`)).rejects.toMatchObject({ cause: { constraint: 'ck_audit_append_only' } });
    await expect(owner.db.execute(sql`update platform_audit_log set action = 'x'`)).rejects.toMatchObject({ cause: { constraint: 'ck_audit_append_only' } });
  });

  it('a API só insere: não lê a trilha nem a cabeça da cadeia', async () => {
    await expect(inCompany(t.api, companyId, sql`select * from audit_log`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(inCompany(t.api, companyId, sql`select * from audit_chain_heads`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(inCompany(t.api, companyId, sql`update audit_chain_heads set last_sequence = 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(t.api.db.execute(sql`select * from platform_audit_log`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('registro que não continua a cadeia é recusado (sequência ou hash anterior errados)', async () => {
    const insert = (sequence: number, prev: string) =>
      inCompany(
        t.api,
        companyId,
        sql`insert into audit_log (id, company_id, sequence, occurred_at, action, actor_kind, actor_id, subject_type, subject_id, details, prev_hash, hash)
            values (gen_random_uuid(), ${companyId}, ${sequence}, now(), 'company.registered', 'SYSTEM', 'x', 'x', 'x', '{}',
                    decode(${prev}, 'hex'), decode(repeat('11', 32), 'hex'))`,
      );
    await expect(insert(1, '00'.repeat(32))).rejects.toMatchObject({ cause: { constraint: 'ck_audit_log_chain' } });
    await expect(insert(999_999, '00'.repeat(32))).rejects.toMatchObject({ cause: { constraint: 'ck_audit_log_chain' } });
  });

  it('a trilha de uma empresa é invisível no contexto de outra (RLS)', async () => {
    const other = await createCompany(t.app, key);
    const rows = await inCompany<{ company_id: string }>(t.adminDb, other.id, sql`select company_id from audit_log`);
    expect(rows.rows.every((r) => r.company_id === other.id)).toBe(true);
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});

describe('detecção de adulteração', () => {
  it('alteração feita por fora (superusuário desligando os triggers) é detectada pelo verificador', async () => {
    const company = await createCompany(t.app, key);
    await createEstablishment(t.app, key, company.id, cnpjOf(company.root));
    expect(await verifier.verify({ kind: 'COMPANY', companyId: company.id })).toMatchObject({ ok: true });

    await superuser.db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger user`);
      await tx.execute(sql`update audit_log set details = jsonb_set(details, '{legalName}', '"OUTRA EMPRESA"') where company_id = ${company.id} and sequence = 1`);
      await tx.execute(sql`alter table audit_log enable trigger user`);
    });
    expect(await verifier.verify({ kind: 'COMPANY', companyId: company.id })).toEqual({ ok: false, sequence: 1, reason: 'HASH_MISMATCH' });
  });

  it('registro apagado do fim é detectado pela cabeça da cadeia', async () => {
    const company = await createCompany(t.app, key);
    await superuser.db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger user`);
      await tx.execute(sql`delete from audit_log where company_id = ${company.id} and sequence = 2`);
      await tx.execute(sql`alter table audit_log enable trigger user`);
    });
    expect(await verifier.verify({ kind: 'COMPANY', companyId: company.id })).toEqual({ ok: false, sequence: 1, reason: 'HEAD_MISMATCH' });
  });
});
