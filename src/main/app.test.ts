import type { HttpApp } from '../shared/presentation/http/http-app.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import type { ReadinessCheck } from '../shared/presentation/http/health.js';
import { HttpProblemError } from '../shared/presentation/http/problem.js';
import { CANARIES, captureStream, expectNoCanary } from '../../test/support/canary.js';
import { buildApp } from './app.js';

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(options: { checks?: ReadinessCheck[]; routes?: (app: HttpApp) => void } = {}) {
  const capture = captureStream();
  const logger = createLogger({ level: 'trace', service: 'test', destination: capture.stream });
  app = await buildApp({
    logger,
    bodyLimit: 1024 * 1024,
    readinessChecks: options.checks ?? [],
    ...(options.routes === undefined ? {} : { registerRoutes: options.routes }),
  });
  return { app, capture };
}

describe('API — fundação', () => {
  it('health/live responde e devolve correlation id gerado', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propaga correlation id seguro e descarta valores inseguros', async () => {
    const { app } = await setup();
    const good = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-correlation-id': 'orbita:req-123456' } });
    expect(good.headers['x-correlation-id']).toBe('orbita:req-123456');
    const bad = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-correlation-id': '<script>alert(1)</script>' } });
    expect(bad.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('health/ready retorna 503 quando uma dependência falha, sem expor o erro', async () => {
    const { app } = await setup({
      checks: [
        { name: 'postgres', check: () => Promise.resolve() },
        { name: 'object-storage', check: () => Promise.reject(new Error(`senha=${CANARIES.password}`)) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: [
        { name: 'postgres', ok: true },
        { name: 'object-storage', ok: false },
      ],
    });
    expectNoCanary(res.body);
  });

  it('rota inexistente → 404 em problem+json, sem query string em instance', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/nao-existe?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', status: 404, instance: '/nao-existe' });
  });

  it('erro de validação → 400 VALIDATION_FAILED com o campo', async () => {
    const { app } = await setup({
      routes: (a) => {
        a.post('/echo', { schema: { body: z.object({ amount: z.string() }) } }, () => ({ ok: true }));
      },
    });
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { amount: 10 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ field: 'body.amount' }] });
  });

  it('HttpProblemError vira problem+json com o código estável', async () => {
    const { app } = await setup({
      routes: (a) => {
        a.get('/conflict', () => {
          throw new HttpProblemError(422, 'IDEMPOTENCY_KEY_REUSED', 'Chave de idempotência reutilizada');
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/conflict' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', type: 'urn:orbita-nfe:problem:idempotency-key-reused' });
  });

  it('erro inesperado → 500 genérico; detalhe só no log; nada de segredo em log ou resposta', async () => {
    const { app, capture } = await setup({
      routes: (a) => {
        a.post('/boom', () => {
          throw Object.assign(new Error('falha no banco'), { connection: { password: CANARIES.password } });
        });
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/boom',
      headers: { authorization: `Bearer ${CANARIES.apiKey}`, 'x-api-key': CANARIES.apiKey },
      payload: { certificatePassword: CANARIES.password, pfx: CANARIES.pfx, csc: CANARIES.csc },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', title: 'Erro interno' });
    expect(res.body).not.toContain('falha no banco');
    expect(capture.text()).toContain('falha no banco');
    expectNoCanary(capture.text());
    expectNoCanary(res.body);
  });

  it('JSON malformado → 400 em problem+json', async () => {
    const { app } = await setup({
      routes: (a) => {
        a.post('/echo', () => ({ ok: true }));
      },
    });
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
