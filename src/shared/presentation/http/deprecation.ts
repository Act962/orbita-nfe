import type { HttpApp } from './http-app.js';

/**
 * Descontinuação de rotas (ADR-0026 item 9; política em docs/api/versionamento.md).
 *
 * Uma rota descontinuada declara `config.deprecation` E `schema.deprecated: true` (o OpenAPI
 * marca a operação). Toda resposta dela leva:
 * - `Deprecation: @<segundos Unix>` (RFC 9745): desde quando está descontinuada;
 * - `Sunset: <HTTP-date>` (RFC 8594): a partir de quando pode deixar de existir;
 * - `Link: <guia de migração>; rel="deprecation"`.
 */
export interface RouteDeprecation {
  readonly since: Date;
  readonly sunset: Date;
  /** Guia de migração (página do changelog). */
  readonly link: string;
}

/** Prazo mínimo entre o anúncio e a remoção de uma rota de /v1 (docs/api/versionamento.md). */
export const MINIMUM_SUNSET_DAYS = 180;

declare module 'fastify' {
  interface FastifyContextConfig {
    deprecation?: RouteDeprecation;
  }
}

export function deprecationHeaders(deprecation: RouteDeprecation): Record<string, string> {
  return {
    deprecation: `@${String(Math.floor(deprecation.since.getTime() / 1000))}`,
    sunset: deprecation.sunset.toUTCString(),
    link: `<${deprecation.link}>; rel="deprecation"; type="text/markdown"`,
  };
}

/** Registrar ANTES das rotas: confere a declaração de cada rota e põe os headers nas respostas. */
export function registerDeprecation(app: HttpApp): void {
  app.addHook('onRoute', (route) => {
    const deprecation = (route.config as { deprecation?: RouteDeprecation } | undefined)?.deprecation;
    const flagged = (route.schema as { deprecated?: boolean } | undefined)?.deprecated === true;
    if (deprecation === undefined) {
      if (flagged) throw new Error(`rota ${route.method.toString()} ${route.url}: schema.deprecated sem config.deprecation (falta a data de Sunset)`);
      return;
    }
    if (!flagged) throw new Error(`rota ${route.method.toString()} ${route.url}: config.deprecation sem schema.deprecated (o OpenAPI não marcaria)`);
    const days = (deprecation.sunset.getTime() - deprecation.since.getTime()) / 86_400_000;
    if (days < MINIMUM_SUNSET_DAYS) throw new Error(`rota ${route.url}: Sunset com menos de ${String(MINIMUM_SUNSET_DAYS)} dias após a descontinuação`);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const deprecation = request.routeOptions.config.deprecation;
    if (deprecation !== undefined) reply.headers(deprecationHeaders(deprecation));
    return payload;
  });
}
