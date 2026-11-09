import type { HttpApp } from './http-app.js';

/** Verificação de dependência para readiness (banco, object storage, KMS...). */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<void>;
}

const CHECK_TIMEOUT_MS = 2000;

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
  app.get('/health/live', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) => {
    const results = await Promise.all(checks.map(runCheck));
    const ready = results.every((r) => r.ok);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: results });
  });
}
