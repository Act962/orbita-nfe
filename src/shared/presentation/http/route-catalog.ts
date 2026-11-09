import type { HttpApp } from './http-app.js';
import type { RouteAuth } from './request-context.js';

export interface RouteCatalogEntry {
  readonly method: string;
  readonly url: string;
  readonly auth: RouteAuth;
}

declare module 'fastify' {
  interface FastifyInstance {
    routeCatalog: readonly RouteCatalogEntry[];
  }
}

export const PROTECTED_PREFIX = '/v1';

/**
 * Registra o catálogo de rotas e impõe a regra fechada: rota sob /v1 sem `config.auth`
 * (ou marcada como pública) impede a aplicação de subir. O catálogo alimenta a matriz de
 * isolamento (docs/architecture/14 §B4, teste 2): rota nova entra no teste automaticamente.
 *
 * Deve ser chamada antes do registro das rotas.
 */
export function registerRouteCatalog(app: HttpApp): void {
  const entries: RouteCatalogEntry[] = [];
  app.decorate('routeCatalog', entries);

  app.addHook('onRoute', (route) => {
    const auth = route.config?.auth;
    const isProtected = route.url === PROTECTED_PREFIX || route.url.startsWith(`${PROTECTED_PREFIX}/`);
    if (isProtected && (auth === undefined || 'public' in auth)) {
      throw new Error(`Rota ${String(route.method)} ${route.url} sem config.auth: toda rota sob ${PROTECTED_PREFIX} exige escopo.`);
    }
    if (auth === undefined) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) entries.push({ method: String(method), url: route.url, auth });
  });
}

/** Rota protegida registrada sem o módulo de autenticação = configuração insegura. */
export function assertAuthenticationRegistered(app: HttpApp): void {
  const needsAuth = app.routeCatalog.some((r) => !('public' in r.auth));
  if (needsAuth && !app.hasRequestDecorator('caller')) {
    throw new Error('Há rotas protegidas, mas a autenticação não foi registrada.');
  }
}
