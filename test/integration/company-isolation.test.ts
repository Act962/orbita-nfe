import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationError, ConflictError, InternalError } from '../../src/shared/application/errors.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { establishments, companies } from '../../src/modules/company/infrastructure/persistence/schema.js';
import { connect, fakeCnpj, newId } from './support/db.js';

/**
 * Isolamento entre empresas com o papel REAL da aplicação (fiscal_api), nunca superusuário
 * (docs/architecture/14 §B4, testes 3 a 6 e 12).
 */
let api: DatabaseHandle;
let tx: CompanyTransactions;

interface Fixture {
  companyId: string;
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

async function createCompanyWithEstablishment(): Promise<Fixture> {
  const companyId = newId();
  const establishmentId = newId();
  const cnpj = fakeCnpj();
  await tx.run(companyId, async (t) => {
    await t.insert(companies).values({ id: companyId, legalName: 'EMPRESA FICTICIA LTDA', rootCnpj: cnpj.slice(0, 8) });
    await t.insert(establishments).values({ id: establishmentId, companyId, cnpj, tradeName: 'Matriz', municipalityCode: '2211001' });
  });
  return { companyId, establishmentId, cnpj };
}

beforeAll(async () => {
  api = connect('api');
  tx = new CompanyTransactions(api.db);
  a = await createCompanyWithEstablishment();
  b = await createCompanyWithEstablishment();
});

afterAll(async () => {
  await api.close();
});

describe('Isolamento multiempresa (RLS) com o papel da aplicação', () => {
  it('cada empresa só vê os próprios dados', async () => {
    const seenByA = await tx.run(a.companyId, (t) => t.select({ id: establishments.id }).from(establishments));
    expect(seenByA.map((r) => r.id)).toEqual([a.establishmentId]);
    const companiesSeenByB = await tx.run(b.companyId, (t) => t.select({ id: companies.id }).from(companies));
    expect(companiesSeenByB.map((r) => r.id)).toEqual([b.companyId]);
  });

  it('sem contexto de empresa, nada é visível (fail-closed)', async () => {
    expect(await api.db.select().from(establishments)).toEqual([]);
    expect(await api.db.select().from(companies)).toEqual([]);
  });

  it('buscar recurso de outra empresa pelo id retorna vazio (a API responderá 404)', async () => {
    const rows = await tx.run(a.companyId, (t) => t.select().from(establishments).where(eq(establishments.id, b.establishmentId)));
    expect(rows).toEqual([]);
  });

  it('INSERT com company_id de outra empresa é barrado pelo WITH CHECK → DATABASE_ACCESS_VIOLATION', async () => {
    const attempt = tx.run(a.companyId, (t) =>
      t.insert(establishments).values({ id: newId(), companyId: b.companyId, cnpj: fakeCnpj(), tradeName: 'Invasor', municipalityCode: '2211001' }),
    );
    await expect(attempt).rejects.toBeInstanceOf(InternalError);
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('UPDATE em dado de outra empresa não afeta nenhuma linha', async () => {
    const updated = await tx.run(a.companyId, (t) =>
      t.update(establishments).set({ tradeName: 'Alterado por A' }).where(eq(establishments.id, b.establishmentId)).returning({ id: establishments.id }),
    );
    expect(updated).toEqual([]);
    const stillOriginal = await tx.run(b.companyId, (t) => t.select({ name: establishments.tradeName }).from(establishments));
    expect(stillOriginal).toEqual([{ name: 'Matriz' }]);
  });

  it('UPDATE que tenta mover a linha para outra empresa é barrado', async () => {
    const attempt = tx.run(a.companyId, (t) => t.update(establishments).set({ companyId: b.companyId }).where(eq(establishments.id, a.establishmentId)));
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('DELETE não é concedido à aplicação', async () => {
    const attempt = tx.run(a.companyId, (t) => t.delete(establishments).where(eq(establishments.id, a.establishmentId)));
    await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('o contexto da empresa não vaza para a próxima transação da mesma conexão do pool', async () => {
    const single = connect('api', { poolMax: 1 });
    try {
      const inside = await new CompanyTransactions(single.db).run(a.companyId, (t) => t.select().from(establishments));
      expect(inside.length).toBe(1);
      const setting = await single.db.execute(sql`select current_setting('app.company_id', true) as company`);
      expect([null, ''].includes((setting.rows[0] as { company: string | null }).company)).toBe(true);
      expect(await single.db.select().from(establishments)).toEqual([]);
    } finally {
      await single.close();
    }
  });

  it('transações concorrentes de empresas diferentes no mesmo pool não se misturam', async () => {
    const runs = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b)).map((f) =>
      tx.run(f.companyId, async (t) => {
        await t.execute(sql`select pg_sleep(0.01)`);
        const rows = await t.select({ companyId: establishments.companyId }).from(establishments);
        return { expected: f.companyId, seen: rows.map((r) => r.companyId) };
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

  it('companyId malformado é recusado antes de qualquer query', async () => {
    await expect(tx.run("x' or '1'='1", () => Promise.resolve(1))).rejects.toThrow('companyId inválido');
  });
});

describe('Erros de banco traduzidos (nada de erro do Drizzle/pg para cima)', () => {
  it('CNPJ já cadastrado em OUTRA empresa → erro de negócio, sem revelar dados da outra empresa', async () => {
    const attempt = tx.run(
      a.companyId,
      (t) => t.insert(establishments).values({ id: newId(), companyId: a.companyId, cnpj: b.cnpj, tradeName: 'Duplicado', municipalityCode: '2211001' }),
      CNPJ_CONSTRAINTS,
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    const error = await rejection(attempt);
    expect(error.code).toBe('ESTABLISHMENT_ALREADY_REGISTERED');
    const serialized = JSON.stringify({ message: error.message, cause: error.cause, issues: error.issues });
    expect(serialized).not.toContain(b.cnpj);
    expect(serialized).not.toContain(b.companyId);
    expect(serialized).not.toContain('Failed query');
  });

  it('violação de CHECK → DATABASE_INTEGRITY_VIOLATION com apenas metadados seguros', async () => {
    const attempt = tx.run(a.companyId, (t) =>
      t.insert(establishments).values({ id: newId(), companyId: a.companyId, cnpj: 'CNPJ-INVALIDO', tradeName: 'X', municipalityCode: '2211001' }),
    );
    const error = await rejection(attempt);
    expect(error.code).toBe('DATABASE_INTEGRITY_VIOLATION');
    expect(error.cause).toEqual({ sqlState: '23514', constraint: 'ck_establishments_cnpj', table: 'establishments' });
  });

  it('statement timeout → DATABASE_TIMEOUT', async () => {
    const slow = connect('api', { statementTimeoutMs: 200 });
    try {
      const attempt = new CompanyTransactions(slow.db).run(a.companyId, (t) => t.execute(sql`select pg_sleep(2)`));
      await expect(attempt).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT', category: 'UNAVAILABLE' });
    } finally {
      await slow.close();
    }
  });

  it('banco inacessível → DATABASE_UNAVAILABLE', async () => {
    const { createDatabase } = await import('../../src/shared/infrastructure/database/database.js');
    const down = createDatabase({ url: 'postgres://ninguem:senha@127.0.0.1:1/x', poolMax: 1, statementTimeoutMs: 1000, applicationName: 'down' });
    try {
      await expect(new CompanyTransactions(down.db).run(a.companyId, () => Promise.resolve(1))).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    } finally {
      await down.close();
    }
  });
});
