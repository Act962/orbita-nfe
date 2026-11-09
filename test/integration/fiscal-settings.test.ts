import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentSeriesRepository } from '../../src/modules/fiscal-settings/public.js';
import { ApplicationError, BusinessRuleError, NotFoundError } from '../../src/shared/application/errors.js';
import { CompanyTransactions } from '../../src/shared/infrastructure/database/database.js';
import { documentSeries } from '../../src/modules/fiscal-settings/infrastructure/persistence/schema.js';
import { bearer, cnpjOf, createClientApp, createEstablishment, createCompany, problemCode, startTestApi, type TestApi } from './support/api.js';
import { newId } from './support/db.js';

/** Séries e alocação transacional de numeração (ADR-0008). */
let t: TestApi;
let key: string;
let companyId: string;
let establishmentId: string;

beforeAll(async () => {
  t = await startTestApi();
  const app = await createClientApp(t.admin, 'nerp');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(company.root));
});
afterAll(async () => {
  await t.close();
});

let seriesSeq = 100;
async function createSeries(body: Record<string, unknown>) {
  return t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(key, companyId), payload: body });
}
async function newSeriesId(kind = 'NFCE', nextNumber?: number): Promise<string> {
  const res = await createSeries({ kind, environment: 'HOMOLOGATION', series: String(++seriesSeq), ...(nextNumber === undefined ? {} : { nextNumber }) });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof ApplicationError)) throw new Error(`esperava ApplicationError: ${String(error)}`);
  return error.code;
}

describe('API de séries', () => {
  it('cria, lista e recusa duplicata', async () => {
    const created = await createSeries({ kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'NFSE_DPS', series: '1', nextNumber: 1, maxNumber: 999_999_999_999_999, status: 'ACTIVE' });

    const dup = await createSeries({ kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' });
    expect(dup.statusCode).toBe(409);
    expect(problemCode(dup)).toBe('DOCUMENT_SERIES_ALREADY_EXISTS');

    // Mesma série em outro ambiente é outra série.
    expect((await createSeries({ kind: 'NFSE_DPS', environment: 'PRODUCTION', series: '1' })).statusCode).toBe(201);

    const list = await t.app.inject({ method: 'GET', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(key, companyId) });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(2);
  });

  it('série inválida para a modalidade → 400 com ruleId SERIES-001', async () => {
    const res = await createSeries({ kind: 'NFE', environment: 'HOMOLOGATION', series: '1000' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ issues: [{ field: 'body.series', code: 'INVALID_SERIES', ruleId: 'SERIES-001' }] });
  });

  it('estabelecimento inexistente → 404 ESTABLISHMENT_NOT_FOUND', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${newId()}/document-series`,
      headers: bearer(key, companyId),
      payload: { kind: 'NFE', environment: 'HOMOLOGATION', series: '1' },
    });
    expect(res.statusCode).toBe(404);
    expect(problemCode(res)).toBe('ESTABLISHMENT_NOT_FOUND');
  });
});

describe('Alocação de numeração', () => {
  it('50 alocações concorrentes → 50 números distintos e consecutivos', async () => {
    const seriesId = await newSeriesId();
    const numbers = await Promise.all(Array.from({ length: 50 }, () => t.modules.fiscalSettings.allocateNumber(companyId, seriesId)));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('ROLLBACK da transação de aceitação devolve o número', async () => {
    const seriesId = await newSeriesId('NFE', 77);
    const transactions = new CompanyTransactions(t.api.db);
    const failed = transactions.run(companyId, async (tx) => {
      const allocated = await documentSeriesRepository(tx).allocateNext(seriesId);
      expect(allocated).toEqual({ kind: 'ALLOCATED', number: 77 });
      // Ex.: a validação da emissão falha depois de alocar o número.
      throw new BusinessRuleError('SIMULATED_FAILURE', 'falha depois de alocar');
    });
    expect(await errorCode(failed)).toBe('SIMULATED_FAILURE');
    expect(await t.modules.fiscalSettings.allocateNumber(companyId, seriesId)).toBe(77);
    expect(await t.modules.fiscalSettings.allocateNumber(companyId, seriesId)).toBe(78);
  });

  it('último número da modalidade → depois, DOCUMENT_SERIES_EXHAUSTED', async () => {
    const seriesId = await newSeriesId('NFE', 999_999_999);
    expect(await t.modules.fiscalSettings.allocateNumber(companyId, seriesId)).toBe(999_999_999);
    expect(await errorCode(t.modules.fiscalSettings.allocateNumber(companyId, seriesId))).toBe('DOCUMENT_SERIES_EXHAUSTED');
  });

  it('série inexistente ou de outra empresa → DOCUMENT_SERIES_NOT_FOUND', async () => {
    const seriesId = await newSeriesId();
    const other = await createCompany(t.app, key);
    expect(await errorCode(t.modules.fiscalSettings.allocateNumber(other.id, seriesId))).toBe('DOCUMENT_SERIES_NOT_FOUND');
    expect(await errorCode(t.modules.fiscalSettings.allocateNumber(companyId, newId()))).toBe('DOCUMENT_SERIES_NOT_FOUND');
  });

  it('série inativa → DOCUMENT_SERIES_INACTIVE', async () => {
    const seriesId = await newSeriesId();
    await new CompanyTransactions(t.api.db).run(companyId, (tx) => tx.update(documentSeries).set({ status: 'INACTIVE' }).where(eq(documentSeries.id, seriesId)));
    expect(await errorCode(t.modules.fiscalSettings.allocateNumber(companyId, seriesId))).toBe('DOCUMENT_SERIES_INACTIVE');
  });
});

describe('Proteções no banco', () => {
  it('o número nunca volta, nem por UPDATE direto (trigger)', async () => {
    const seriesId = await newSeriesId('NFE', 10);
    const attempt = new CompanyTransactions(t.api.db).run(companyId, (tx) =>
      tx.execute(sql`update document_series set next_number = 5 where id = ${seriesId}`),
    );
    expect(await errorCode(attempt)).toBe('DATABASE_INTEGRITY_VIOLATION');
  });

  it('a API não altera a identidade da série (grant por coluna)', async () => {
    const seriesId = await newSeriesId();
    const attempt = new CompanyTransactions(t.api.db).run(companyId, (tx) =>
      tx.execute(sql`update document_series set series = '999' where id = ${seriesId}`),
    );
    expect(await errorCode(attempt)).toBe('DATABASE_ACCESS_VIOLATION');
  });

  it('FK composta: série não referencia estabelecimento de outra empresa', async () => {
    const other = await createCompany(t.app, key);
    const attempt = new CompanyTransactions(t.api.db).run(
      other.id,
      (tx) =>
        tx.insert(documentSeries).values({
          id: newId(),
          companyId: other.id,
          establishmentId,
          kind: 'NFE',
          environment: 'HOMOLOGATION',
          series: '1',
          nextNumber: 1,
          maxNumber: 999_999_999,
        }),
      { fk_document_series_establishment: () => new NotFoundError('FK_BLOCKED') },
    );
    expect(await errorCode(attempt)).toBe('FK_BLOCKED');
  });
});
