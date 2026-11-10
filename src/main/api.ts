import { createDatabase, databaseReadinessCheck } from '../shared/infrastructure/database/database.js';
import { loadPublicKek } from '../modules/certificates/public.js';
import { loadPepperFile } from '../modules/iam/public.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { buildApp } from './app.js';
import { composeApi } from './compose.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'api' });

const database = createDatabase({
  url: config.DATABASE_URL,
  poolMax: config.DATABASE_POOL_MAX,
  statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  applicationName: 'orbita-nfe-api',
});

const perMinute = (limit: number, burst: number) => ({ capacity: burst, refillPerSecond: limit / 60 });

const modules = composeApi({
  db: database.db,
  apiKeyPepper: loadPepperFile(config.API_KEY_PEPPER_FILE),
  certificateKek: loadPublicKek(config.CERTIFICATE_KEK_PUBLIC_FILE),
  webhookSecretKey: loadPublicKek(config.WEBHOOK_SECRET_KEY_PUBLIC_FILE),
  allowPrivateWebhookTargets: config.WEBHOOK_ALLOW_PRIVATE_TARGETS,
  rateLimit: {
    perCredential: perMinute(config.RATE_LIMIT_PER_MINUTE, config.RATE_LIMIT_BURST),
    perAddress: perMinute(config.RATE_LIMIT_ADDRESS_PER_MINUTE, config.RATE_LIMIT_ADDRESS_BURST),
  },
});

const app = await buildApp({
  logger,
  bodyLimit: config.HTTP_BODY_LIMIT,
  readinessChecks: [databaseReadinessCheck(database.pool)],
  apiDocs: { enabled: config.API_DOCS_ENABLED, version: config.APP_VERSION },
  registerRoutes: modules.registerRoutes,
});

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'encerrando');
  app
    .close()
    .then(() => database.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'falha ao encerrar');
        process.exit(1);
      },
    );
};
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
