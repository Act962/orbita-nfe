import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'api' });

const app = await buildApp({ logger, bodyLimit: config.HTTP_BODY_LIMIT, readinessChecks: [] });

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'encerrando');
  app.close().then(
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
