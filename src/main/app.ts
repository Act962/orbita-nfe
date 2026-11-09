import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerApiDocs } from '../shared/presentation/http/api-docs.js';
import { CORRELATION_HEADER, correlationIdFrom } from '../shared/presentation/http/correlation-id.js';
import { registerErrorHandling } from '../shared/presentation/http/error-handler.js';
import { registerHealthRoutes, type ReadinessCheck } from '../shared/presentation/http/health.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';
import { configureZodLocale } from '../shared/presentation/http/zod-locale.js';

export interface AppDependencies {
  readonly logger: FastifyBaseLogger;
  readonly bodyLimit: number;
  readonly readinessChecks: readonly ReadinessCheck[];
  readonly apiDocs: { readonly enabled: boolean; readonly version: string };
  /** Registro de rotas dos módulos (composition root). */
  readonly registerRoutes?: (app: HttpApp) => void;
}

/** Monta a aplicação HTTP. Sem efeitos colaterais (não escuta porta): usado também pelos testes. */
export async function buildApp(deps: AppDependencies): Promise<HttpApp> {
  configureZodLocale();

  const app: HttpApp = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: deps.bodyLimit,
    genReqId: correlationIdFrom,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    // Atrás do proxy do Coolify (mesma rede). Revisar se a topologia mudar.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    reply.header(CORRELATION_HEADER, request.id);
  });

  registerErrorHandling(app);
  await registerApiDocs(app, deps.apiDocs);
  registerHealthRoutes(app, deps.readinessChecks);
  deps.registerRoutes?.(app);

  await app.ready();
  return app;
}
