import { S3AnchorStore } from '../modules/audit/public.js';
import { loadPrivateKek } from '../modules/certificates/public.js';
import { anchorStoreOptions } from './anchor-config.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { composeGeneralWorker } from './compose.js';
import { loadGeneralWorkerConfig } from './worker-config.js';
import { runWorker } from './worker-runtime.js';

/**
 * worker-general (ADR-0021): outbox e entrega de webhooks. É a superfície mais exposta (faz
 * requisições a URLs de clientes), por isso nunca recebe material de certificados.
 */
const config = loadGeneralWorkerConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'worker-general' });
const database = createDatabase({ url: config.GENERAL_DATABASE_URL, poolMax: config.WORKER_CONCURRENCY + 2, statementTimeoutMs: 30_000, applicationName: 'orbita-nfe-worker-general' });

const anchorOptions = anchorStoreOptions(config);
const anchorStore = anchorOptions === undefined ? undefined : new S3AnchorStore(anchorOptions);
if (anchorStore === undefined) logger.warn('âncora da auditoria não configurada: filas audit.anchor-* paradas (só fora de produção)');

// A chave dos segredos de webhook usa o mesmo formato e tamanho mínimo da KEK (RSA 4096, PEM).
const general = composeGeneralWorker({
  db: database.db,
  webhookSecretKeys: [loadPrivateKek(config.GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE)],
  allowPrivateWebhookTargets: config.WEBHOOK_ALLOW_PRIVATE_TARGETS,
  webhookTimeoutMs: config.WEBHOOK_TIMEOUT_MS,
  ...(anchorStore === undefined ? {} : { anchorStore }),
});

await general.ensureRecurringJobs();

runWorker({
  lane: 'general',
  database,
  handlers: general.handlers,
  logger,
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  retentionDays: config.JOB_RETENTION_DAYS,
  onClose: async () => {
    await general.close();
    anchorStore?.close();
  },
});
