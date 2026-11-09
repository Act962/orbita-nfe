import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationError, ConflictError, InternalError } from '../../src/shared/application/errors.js';
import { TenantTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { establishments, tenants } from '../../src/modules/taxpayer/infrastructure/persistence/schema.js';
import { connect, fakeCnpj, newId } from './support/db.js';

/**
 * Isolamento entre empresas com o papel REAL da aplicação (fiscal_api), nunca superusuário
 * (docs/architecture/14 §B4, testes 3 a 6 e 12).
 */
let api: DatabaseHandle;
let tx: TenantTransactions;

interface Fixture {
  tenantId: string;
  establishmentId: string;
  cnpj: string;
}
let a: Fixture;
let b: Fixture;

/** Captura o erro rejeitado (o teste falha se a promessa resolver). */
async function rejection(promise: Promise<unknown>): Promise<ApplicationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApplicationError) return error;
    throw error;
  }
  throw new Error('esperava rejeição');
}

const CNPJ_CONSTRAINTS = {
  uq_establishments_cnpj: () => new ConflictError('ESTABLISHMENT_ALREADY_REGISTERED', 'Estabelecimento já cadastrado.'),
};

async function createTenantWithEstablishment(): Promise<Fixture> {
  const tenantId = newId();
  const establishmentId = newId();
  const cnpj = fakeCnpj();
  await tx.run(tenantId, async (t) => {
    await t.insert(tenants).values({ id: tenantId, legalName: 'EMPRESA FICTICIA LTDA', rootCnpj: cnpj.slice(0, 8) });
    await t.insert(establishments).values({ id: establishmentId, tenantId, cnpj, tradeName: 'Matriz', municipalityCode: '2211001' });
  });
  return { tenantId, establishmentId, cnpj };
}

beforeAll(async () => {
  api = connect('api');
  tx = new TenantTransactions(api.db);
  a = await createTenantWithEstablishment();
  b = await createTenantWithEstablishment();
});

afterAll(async () => {
  await api.close();
});

describe('Isolamento multi-tenant (RLS) com o papel da aplicação', () => {
  it('cada tenant só vê os próprios dados', async () => {
    const seenByA = await tx.run(a.tenantId, (t) => t.select({ id: establishments.id }).from(establishments));
    expect(seenByA.map((r) => r.id)).toEqual([a.establishmentId]);
    const tenantsSeenByB = await tx.run(b.tenantId, (t) => t.select({ id: tenants.id }).from(tenants));
    expect(tenantsSeenByB.map((r) => r.id)).toEqual([b.tenantId]);
  });

  it('sem contexto de tenant, nada é visível (fail-closed)', async () => {
    expect(await api.db.select().from(establishments)).toEqual([]);
    expect(await api.db.select().from(tenants)).toEqual([]);
  });

  it('buscar recurso de outro tenant pelo id retorna vazio (a API responderá 404)', async () => {
    const rows = await tx.run(a.tenantId, (t) => t.select().from(establishments).where(eq(establishments.id, b.establishmentId)));
    expect(rows).toEqual([]);
  });

  it('INSERT com tenant_id de outro tenant é barrado pelo WITH CHECK → DATABASE_ACCESS_VIOLATION', async () => {
    const attempt = tx.run(a.tenantId, (t) =>
      t.insert(establishments).values({ id: newId(), tenantId: b.tenantId, cnpj: fakeCnpj(), tradeName: 'Invasor', municipalityCode: '2211001' }),
    );
    await expect(attempt).rejects.toBeInstanceOf(InternalError);
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('UPDATE em dado de outro tenant não afeta nenhuma linha', async () => {
    const updated = await tx.run(a.tenantId, (t) =>
      t.update(establishments).set({ tradeName: 'Alterado por A' }).where(eq(establishments.id, b.establishmentId)).returning({ id: establishments.id }),
    );
    expect(updated).toEqual([]);
    const stillOriginal = await tx.run(b.tenantId, (t) => t.select({ name: establishments.tradeName }).from(establishments));
    expect(stillOriginal).toEqual([{ name: 'Matriz' }]);
  });

  it('UPDATE que tenta mover a linha para outro tenant é barrado', async () => {
    const attempt = tx.run(a.tenantId, (t) => t.update(establishments).set({ tenantId: b.tenantId }).where(eq(establishments.id, a.establishmentId)));
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('DELETE não é concedido à aplicação', async () => {
    const attempt = tx.run(a.tenantId, (t) => t.delete(establishments).where(eq(establishments.id, a.establishmentId)));
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('o contexto do tenant não vaza para a próxima transação da mesma conexão do pool', async () => {
    const single = connect('api', { poolMax: 1 });
    try {
      const inside = await new TenantTransactions(single.db).run(a.tenantId, (t) => t.select().from(establishments));
      expect(inside.length).toBe(1);
      const setting = await single.db.execute(sql`select current_setting('app.tenant_id', true) as tenant`);
      expect([null, ''].includes((setting.rows[0] as { tenant: string | null }).tenant)).toBe(true);
      expect(await single.db.select().from(establishments)).toEqual([]);
    } finally {
      await single.close();
    }
  });

  it('transações concorrentes de tenants diferentes no mesmo pool não se misturam', async () => {
    const runs = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b)).map((f) =>
      tx.run(f.tenantId, async (t) => {
        await t.execute(sql`select pg_sleep(0.01)`);
        const rows = await t.select({ tenantId: establishments.tenantId }).from(establishments);
        return { expected: f.tenantId, seen: rows.map((r) => r.tenantId) };
      }),
    );
    for (const result of await Promise.all(runs)) expect(result.seen).toEqual([result.expected]);
  });

  it('o dono das tabelas (sem superuser) também é barrado pelo FORCE RLS', async () => {
    const owner = connect('owner');
    try {
      expect(await owner.db.select().from(establishments)).toEqual([]);
    } finally {
      await owner.close();
    }
  });

  it('tenantId malformado é recusado antes de qualquer query', async () => {
    await expect(tx.run("x' or '1'='1", () => Promise.resolve(1))).rejects.toThrow('tenantId inválido');
  });
});

describe('Erros de banco traduzidos (nada de erro do Drizzle/pg para cima)', () => {
  it('CNPJ já cadastrado em OUTRO tenant → erro de negócio, sem revelar dados do outro tenant', async () => {
    const attempt = tx.run(
      a.tenantId,
      (t) => t.insert(establishments).values({ id: newId(), tenantId: a.tenantId, cnpj: b.cnpj, tradeName: 'Duplicado', municipalityCode: '2211001' }),
      CNPJ_CONSTRAINTS,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    const error = await rejection(attempt);
    expect(error.code).toBe('ESTABLISHMENT_ALREADY_REGISTERED');
    const serialized = JSON.stringify({ message: error.message, cause: error.cause, issues: error.issues });
    expect(serialized).not.toContain(b.cnpj);
    expect(serialized).not.toContain(b.tenantId);
    expect(serialized).not.toContain('Failed query');
  });

  it('violação de CHECK → DATABASE_INTEGRITY_VIOLATION com apenas metadados seguros', async () => {
    const attempt = tx.run(a.tenantId, (t) =>
      t.insert(establishments).values({ id: newId(), tenantId: a.tenantId, cnpj: 'CNPJ-INVALIDO', tradeName: 'X', municipalityCode: '2211001' }),
    );
    const error = await rejection(attempt);
    expect(error.code).toBe('DATABASE_INTEGRITY_VIOLATION');
    expect(error.cause).toEqual({ sqlState: '23514', constraint: 'ck_establishments_cnpj', table: 'establishments' });
  });

  it('statement timeout → DATABASE_TIMEOUT', async () => {
    const slow = connect('api', { statementTimeoutMs: 200 });
    try {
      const attempt = new TenantTransactions(slow.db).run(a.tenantId, (t) => t.execute(sql`select pg_sleep(2)`));
      await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT', category: 'UNAVAILABLE' });
    } finally {
      await slow.close();
    }
  });

  it('banco inacessível → DATABASE_UNAVAILABLE', async () => {
    const { createDatabase } = await import('../../src/shared/infrastructure/database/database.js');
    const down = createDatabase({ url: 'postgres://ninguem:senha@127.0.0.1:1/x', poolMax: 1, statementTimeoutMs: 1000, applicationName: 'down' });
    try {
      await expect(new TenantTransactions(down.db).run(a.tenantId, () => Promise.resolve(1))).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    } finally {
      await down.close();
    }
  });
});
