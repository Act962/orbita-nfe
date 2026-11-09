import { z } from 'zod';
import type { ReadinessCheck } from '../../application/readiness.js';
import type { HttpApp } from './http-app.js';
import { ProblemSchema } from './problem.js';

export type { ReadinessCheck };

const CHECK_TIMEOUT_MS = 2000;

const LiveResponse = z.object({ status: z.literal('ok') }).meta({ id: 'LiveStatus' });

const ReadyResponse = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  })
  .meta({ id: 'ReadyStatus' });

async function runCheck(check: ReadinessCheck): Promise<{ name: string; ok: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('timeout')); }, CHECK_TIMEOUT_MS);
      }),
    ]);
    return { name: check.name, ok: true };
  } catch {
    return { name: check.name, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * /health/live: o processo está de pé (sem dependências).
 * /health/ready: dependências respondem; só então o proxy envia tráfego.
 * Respostas não expõem detalhes de erro (só nome e ok).
 */
export function registerHealthRoutes(app: HttpApp, checks: readonly ReadinessCheck[]): void {
  app.get(
    '/health/live',
    {
      logLevel: 'warn',
      schema: { tags: ['Operação'], summary: 'Liveness', description: 'O processo está em execução.', response: { 200: LiveResponse, 500: ProblemSchema } },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      logLevel: 'warn',
      schema: {
        tags: ['Operação'],
        summary: 'Readiness',
        description: 'Todas as dependências respondem. Retorna 503 se alguma falhar (sem expor o motivo).',
        response: { 200: ReadyResponse, 503: ReadyResponse, 500: ProblemSchema },
      },
    },
    async (_request, reply) => {
      const results = await Promise.all(checks.map(runCheck));
      const ready = results.every((r) => r.ok);
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: results });
    },
  );
}
