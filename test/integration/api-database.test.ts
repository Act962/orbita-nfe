import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../../src/main/app.js';
import { establishments, companies } from '../../src/modules/company/infrastructure/persistence/schema.js';
import { ConflictError } from '../../src/shared/application/errors.js';
import { createLogger } from '../../src/shared/infrastructure/logging/logger.js';
import { createDatabase, databaseReadinessCheck, CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import type { HttpApp } from '../../src/shared/presentation/http/http-app.js';
import { CANARIES, captureStream, expectNoCanary } from '../support/canary.js';
import { connect, fakeCnpj, newId } from './support/db.js';

/**
 * Ponta a ponta HTTP + PostgreSQL: erros de banco chegam ao cliente apenas como
 * problem+json com código estável — nunca a mensagem do Drizzle/pg (que contém query e parâmetros).
 */
let api: DatabaseHandle;
let app: HttpApp;
const capture = captureStream();
const companyId = newId();
const cnpj = fakeCnpj();

beforeAll(async () => {
  api = connect('api');
  const tx = new CompanyTransactions(api.db);
  await tx.run(companyId, async (t) => {
    await t.insert(companies).values({ id: companyId, legalName: 'EMPRESA FICTICIA LTDA', rootCnpj: cnpj.slice(0, 8) });
    await t.insert(establishments).values({ id: newId(), companyId, cnpj, tradeName: 'Matriz', municipalityCode: '2211001' });
  });

  app = await buildApp({
    logger: createLogger({ level: 'trace', service: 'test', destination: capture.stream }),
    bodyLimit: 1024 * 1024,
    readinessChecks: [databaseReadinessCheck(api.pool)],
    apiDocs: { enabled: false, version: 'test' },
    registerRoutes: (a) => {
      // Rotas de teste que exercitam cada caminho de erro do banco.
      a.post('/test/establishments', { schema: { body: z.object({ cnpj: z.string(), tradeName: z.string() }) } }, async (request) => {
        await tx.run(
          companyId,
          (t) => t.insert(establishments).values({ id: newId(), companyId, cnpj: request.body.cnpj, tradeName: request.body.tradeName, municipalityCode: '2211001' }),
          { uq_establishments_cnpj: () => new ConflictError('ESTABLISHMENT_ALREADY_REGISTERED', 'Estabelecimento já cadastrado.') },
        );
        return { ok: true };
      });
      a.post('/test/unmapped', async () => {
        // Sem mapeamento de constraint: bug → 500 genérico.
        await tx.run(companyId, (t) => t.insert(companies).values({ id: companyId, legalName: CANARIES.password, rootCnpj: cnpj.slice(0, 8) }));
        return { ok: true };
      });
      a.post('/test/raw-drizzle-error', async () => {
        // Simula um caminho que esqueceu de traduzir: o handler global ainda protege a resposta.
        await api.db.insert(companies).values({ id: 'nao-e-uuid', legalName: CANARIES.password, rootCnpj: 'XX' });
        return { ok: true };
      });
    },
  });
});

afterAll(async () => {
  await app.close();
  await api.close();
});

describe('API + banco: erros sem detalhes de Drizzle/PostgreSQL', () => {
  it('readiness real com PostgreSQL → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: [{ name: 'postgres', ok: true }] });
  });

  it('constraint mapeada → 409 com código de negócio', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/establishments', payload: { cnpj, tradeName: 'Outra' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ESTABLISHMENT_ALREADY_REGISTERED', status: 409 });
    expect(res.body).not.toContain(cnpj);
  });

  it('constraint não mapeada → 500 INTERNAL_ERROR genérico; código interno só no log', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/unmapped' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', title: 'Erro interno' });
    expect(res.body).not.toMatch(/Failed query|duplicate key|companies|constraint/i);
    expect(capture.text()).toContain('DATABASE_UNMAPPED_UNIQUE_VIOLATION');
  });

  it('erro bruto do Drizzle que escapou → 500 genérico; nem resposta nem log contêm query ou parâmetros', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/raw-drizzle-error' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toMatch(/Failed query|params|invalid input syntax/i);
    expectNoCanary(res.body);
    expectNoCanary(capture.text());
  });

  it('readiness com banco inacessível → 503 sem motivo', async () => {
    const down = createDatabase({ url: 'postgres://x:y@127.0.0.1:1/z', poolMax: 1, statementTimeoutMs: 500, applicationName: 'down' });
    const downApp = await buildApp({
      logger: createLogger({ level: 'silent', service: 'test' }),
      bodyLimit: 1024,
      readinessChecks: [databaseReadinessCheck(down.pool)],
      apiDocs: { enabled: false, version: 'test' },
    });
    try {
      const res = await downApp.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'not_ready', checks: [{ name: 'postgres', ok: false }] });
    } finally {
      await downApp.close();
      await down.close();
    }
  });
});
