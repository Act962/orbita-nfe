import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationFailedError,
} from '../shared/application/errors.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import type { ReadinessCheck } from '../shared/presentation/http/health.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';
import { ProblemSchema } from '../shared/presentation/http/problem.js';
import { CANARIES, captureStream, expectNoCanary } from '../../test/support/canary.js';
import { AccessControl, registerAuthentication } from '../modules/iam/public.js';
import { buildApp } from './app.js';

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(options: { checks?: ReadinessCheck[]; routes?: (app: HttpApp) => void; docs?: boolean; bodyLimit?: number } = {}) {
  const capture = captureStream();
  const logger = createLogger({ level: 'trace', service: 'test', destination: capture.stream });
  app = await buildApp({
    logger,
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
    readinessChecks: options.checks ?? [],
    apiDocs: { enabled: options.docs ?? false, version: '9.9.9-test' },
    ...(options.routes === undefined ? {} : { registerRoutes: options.routes }),
  });
  return { app, capture };
}

describe('API — fundação', () => {
  it('health/live responde e devolve correlation id gerado', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
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
    expect(res.json()).toEqual({ status: 'not_ready', checks: [{ name: 'postgres', ok: true }, { name: 'object-storage', ok: false }] });
    expectNoCanary(res.body);
  });
});

describe('Validação de entrada (Fastify + Zod)', () => {
  const routes = (a: HttpApp): void => {
    a.post(
      '/echo/:id',
      {
        schema: {
          params: z.object({ id: z.uuid() }),
          querystring: z.object({ page: z.coerce.number().int().min(1) }),
          headers: z.object({ 'idempotency-key': z.string().min(8) }),
          body: z.object({ amount: z.string().regex(/^\d+\.\d{2}$/), taker: z.object({ name: z.string().min(2) }) }),
          response: { 200: z.object({ ok: z.boolean() }) },
        },
      },
      () => ({ ok: true }),
    );
  };

  it('corpo inválido → 400 VALIDATION_FAILED com cada campo, código estável e mensagem em pt-BR', async () => {
    const { app } = await setup({ routes });
    const res = await app.inject({
      method: 'POST',
      url: '/echo/0b9c44de-0000-4000-8000-000000000000?page=1',
      headers: { 'idempotency-key': 'chave-123456' },
      payload: { amount: 10, taker: { name: 'A' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = ProblemSchema.parse(res.json());
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'body.amount', code: 'INVALID_TYPE', message: expect.stringContaining('esperava') as string }),
        expect.objectContaining({ field: 'body.taker.name', code: 'TOO_SMALL' }),
      ]),
    );
  });

  it.each([
    ['params', '/echo/nao-e-uuid?page=1', { 'idempotency-key': 'chave-123456' }, 'params.id'],
    ['querystring', '/echo/0b9c44de-0000-4000-8000-000000000000?page=0', { 'idempotency-key': 'chave-123456' }, 'querystring.page'],
    ['headers', '/echo/0b9c44de-0000-4000-8000-000000000000?page=1', { 'idempotency-key': 'x' }, 'headers.idempotency-key'],
  ])('%s inválido → campo %s', async (_ctx, url, headers, field) => {
    const { app } = await setup({ routes });
    const res = await app.inject({ method: 'POST', url, headers, payload: { amount: '1.00', taker: { name: 'Ana' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', issues: [expect.objectContaining({ field })] });
  });

  it('resposta que não bate com o schema declarado → 500 genérico (nunca dados fora do contrato)', async () => {
    const { app, capture } = await setup({
      routes: (a) => {
        a.get('/leak', { schema: { response: { 200: z.object({ ok: z.boolean() }) } } }, () => ({ ok: 'sim', secret: CANARIES.password }) as unknown as { ok: boolean });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/leak' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expectNoCanary(res.body);
    expect(capture.text()).toContain('resposta não corresponde ao schema declarado');
  });

  it.each([
    ['JSON malformado', { 'content-type': 'application/json' }, '{"a":', 400, 'MALFORMED_BODY'],
    ['Content-Type não suportado', { 'content-type': 'application/x-desconhecido' }, 'abc', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('%s → %i %s', async (_name, headers, payload, status, code) => {
    const { app } = await setup({ routes: (a) => a.post('/raw', () => ({ ok: true })) });
    const res = await app.inject({ method: 'POST', url: '/raw', headers, payload });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code });
  });

  it('corpo acima do limite → 413 PAYLOAD_TOO_LARGE', async () => {
    const { app } = await setup({ bodyLimit: 1024, routes: (a) => a.post('/raw', () => ({ ok: true })) });
    const res = await app.inject({ method: 'POST', url: '/raw', payload: { data: 'x'.repeat(5000) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rota inexistente → 404 ROUTE_NOT_FOUND, sem query string em instance', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/nao-existe?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND', status: 404, instance: '/nao-existe' });
  });
});

describe('Erros de aplicação → problem+json com código estável', () => {
  it.each([
    [new ValidationFailedError([{ code: 'CNPJ_INVALID_CHECK_DIGITS', message: 'DV inválido', field: 'cnpj', ruleId: 'CNPJ-001' }]), 400, 'VALIDATION_FAILED'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED'],
    [new ForbiddenError('COMPANY_ACCESS_DENIED'), 403, 'COMPANY_ACCESS_DENIED'],
    [new NotFoundError('DOCUMENT_NOT_FOUND', 'Documento não encontrado.'), 404, 'DOCUMENT_NOT_FOUND'],
    [new ConflictError('IDEMPOTENCY_KEY_REUSED', 'Chave reutilizada com outro conteúdo.'), 409, 'IDEMPOTENCY_KEY_REUSED'],
    [new BusinessRuleError('CERTIFICATE_EXPIRED', 'Certificado vencido.'), 422, 'CERTIFICATE_EXPIRED'],
    [new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'Banco indisponível.', 7), 503, 'DATABASE_UNAVAILABLE'],
  ])('%s → %i', async (error, status, code) => {
    const { app } = await setup({
      routes: (a) => {
        a.get('/fail', () => {
          throw error;
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/fail' });
    expect(res.statusCode).toBe(status);
    const body = ProblemSchema.parse(res.json());
    expect(body).toMatchObject({ code, status, type: `urn:orbita-nfe:problem:${code.toLowerCase().replaceAll('_', '-')}` });
    if (error instanceof ValidationFailedError) expect(body.issues).toEqual([{ code: 'CNPJ_INVALID_CHECK_DIGITS', message: 'DV inválido', field: 'cnpj', ruleId: 'CNPJ-001' }]);
    if (error instanceof ServiceUnavailableError) expect(res.headers['retry-after']).toBe('7');
  });

  it('InternalError → 500 INTERNAL_ERROR; o código interno fica só no log', async () => {
    const { app, capture } = await setup({
      routes: (a) => {
        a.get('/fail', () => {
          throw new InternalError('DATABASE_UNMAPPED_UNIQUE_VIOLATION');
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/fail' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', title: 'Erro interno' });
    expect(res.body).not.toContain('DATABASE_UNMAPPED');
    expect(capture.text()).toContain('DATABASE_UNMAPPED_UNIQUE_VIOLATION');
  });

  it('erro inesperado → 500 genérico; nada de segredo no log ou na resposta', async () => {
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
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toContain('falha no banco');
    expect(capture.text()).toContain('falha no banco');
    expectNoCanary(capture.text());
    expectNoCanary(res.body);
  });
});

describe('Documentação da API (OpenAPI + Scalar)', () => {
  it('serve o OpenAPI 3.1 gerado dos schemas Zod, com o schema Problem reutilizado', async () => {
    const { app } = await setup({ docs: true });
    const res = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{
      openapi: string;
      info: { version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe('9.9.9-test');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health/live', '/health/ready']));
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/docs'))).toBe(false);
    expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining(['Problem', 'ProblemIssue', 'LiveStatus', 'ReadyStatus']));
  });

  it('serve a interface Scalar em /docs/ com assets locais (sem CDN)', async () => {
    const { app } = await setup({ docs: true });
    const redirect = await app.inject({ method: 'GET', url: '/docs' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/docs/');
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<title>Motor Fiscal — API</title>');
    expect(page.body).toContain('src="js/scalar.js"');
    expect(page.body).not.toMatch(/https?:\/\/(cdn|unpkg|fonts)/);
    // Recursos que enviariam o documento para a nuvem da Scalar ficam desligados.
    expect(page.body).toContain('"showDeveloperTools": "never"');
    expect(page.body).toMatch(/"agent":\s*\{\s*"disabled": true/);
    expect(page.body).toContain('"telemetry": false');
    const script = await app.inject({ method: 'GET', url: '/docs/js/scalar.js' });
    expect(script.statusCode).toBe(200);
  });

  it('com a documentação desligada, /docs não existe', async () => {
    const { app } = await setup({ docs: false });
    const res = await app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(404);
  });
});

describe('API — rotas protegidas (padrão fechado)', () => {
  const noAccess = new AccessControl(
    { findActiveByKeyId: () => Promise.resolve(undefined) },
    { hash: () => new Uint8Array(32), matches: () => false },
    { accessOf: () => Promise.resolve('NO_GRANT') },
  );

  it('rota sob /v1 sem config.auth impede a subida', async () => {
    await expect(setup({ routes: (a) => { a.get('/v1/aberta', () => ({})); } })).rejects.toThrow(/sem config.auth/);
  });

  it('rota sob /v1 marcada como pública impede a subida', async () => {
    await expect(setup({ routes: (a) => { a.get('/v1/aberta', { config: { auth: { public: true } } }, () => ({})); } })).rejects.toThrow(/sem config.auth/);
  });

  it('rota protegida sem a autenticação registrada impede a subida', async () => {
    await expect(
      setup({ routes: (a) => { a.get('/v1/x', { config: { auth: { scope: 'companies:read', company: true } } }, () => ({})); } }),
    ).rejects.toThrow(/autenticação não foi registrada/);
  });

  it('escopo fora do catálogo impede a subida', async () => {
    await expect(
      setup({
        routes: (a) => {
          registerAuthentication(a, noAccess);
          a.get('/v1/x', { config: { auth: { scope: 'tudo:liberado', company: false } } }, () => ({}));
        },
      }),
    ).rejects.toThrow(/fora do catálogo/);
  });

  it('com autenticação registrada, a rota responde 401 sem credencial', async () => {
    const { app } = await setup({
      routes: (a) => {
        registerAuthentication(a, noAccess);
        a.get('/v1/x', { config: { auth: { scope: 'companies:read', company: false } } }, () => ({ ok: true }));
      },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/x', headers: { authorization: `Bearer fk_live_${'a'.repeat(16)}_${'b'.repeat(43)}` } });
    expect(res.statusCode).toBe(401);
    expect(app.routeCatalog.filter((r) => r.url === '/v1/x').map((r) => r.method)).toEqual(['GET', 'HEAD']);
  });
});

describe('Documentação para agentes (ADR-0027 item 8)', () => {
  it('/openapi.json é o mesmo contrato de /docs/openapi.json', async () => {
    const { app } = await setup({ docs: true });
    const stable = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(stable.statusCode).toBe(200);
    const docs = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(stable.json()).toEqual(docs.json());
    expect(Object.keys(stable.json<{ paths: object }>().paths)).not.toContain('/llms.txt');
  });

  it('/llms.txt lista o contrato e os guias; todo link de guia responde Markdown', async () => {
    const { app } = await setup({ docs: true });
    const index = await app.inject({ method: 'GET', url: '/llms.txt' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/markdown');
    expect(index.body).toMatch(/^# Motor Fiscal/);
    const links = [...index.body.matchAll(/\]\((\/guides\/[^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBe(4);
    for (const link of links) {
      const page = await app.inject({ method: 'GET', url: link });
      expect(page.statusCode, link).toBe(200);
      expect(page.body, link).toMatch(/^---\r?\ntitle: /);
    }
  });

  it('guia fora da lista fechada → 400 (sem leitura arbitrária de arquivo)', async () => {
    const { app } = await setup({ docs: true });
    for (const url of ['/guides/..%2F..%2Fpackage.json', '/guides/README.md', '/guides/changelog']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(400);
    }
  });

  it('com a documentação desligada, /openapi.json e /llms.txt não existem', async () => {
    const { app } = await setup({ docs: false });
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/llms.txt' })).statusCode).toBe(404);
  });
});

describe('Descontinuação de rotas (ADR-0026 item 9)', () => {
  const since = new Date('2027-01-01T00:00:00Z');
  const deprecation = { since, sunset: new Date('2027-07-01T00:00:00Z'), link: '/guides/changelog.md' };

  it('rota descontinuada responde com Deprecation, Sunset e Link, e o OpenAPI a marca', async () => {
    const { app } = await setup({
      docs: true,
      routes: (a) => {
        a.get('/legado', { config: { deprecation }, schema: { deprecated: true } }, () => ({ ok: true }));
      },
    });
    const res = await app.inject({ method: 'GET', url: '/legado' });
    expect(res.headers['deprecation']).toBe('@1798761600');
    expect(res.headers['sunset']).toBe('Thu, 01 Jul 2027 00:00:00 GMT');
    expect(res.headers['link']).toBe('</guides/changelog.md>; rel="deprecation"; type="text/markdown"');
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{ paths: Record<string, { get: { deprecated?: boolean } }> }>();
    expect(spec.paths['/legado']?.get.deprecated).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/health/live' })).headers['deprecation']).toBeUndefined();
  });

  it('declaração incompleta ou prazo curto impedem a subida', async () => {
    await expect(
      setup({
        routes: (a) => {
          a.get('/x', { schema: { deprecated: true } }, () => ({}));
        },
      }),
    ).rejects.toThrow(/Sunset/);
    await expect(
      setup({
        routes: (a) => {
          a.get('/x', { config: { deprecation } }, () => ({}));
        },
      }),
    ).rejects.toThrow(/schema.deprecated/);
    const short = { ...deprecation, sunset: new Date('2027-02-01T00:00:00Z') };
    await expect(
      setup({
        routes: (a) => {
          a.get('/x', { config: { deprecation: short }, schema: { deprecated: true } }, () => ({}));
        },
      }),
    ).rejects.toThrow(/180 dias/);
  });
});
