import { loadPrivateKek, X509TrustStore } from '../modules/certificates/public.js';
import { SimulatedNfseGateway, XmlDpsPreparer } from '../modules/nfse/public.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { composeFiscalWorker } from './compose.js';
import { loadFiscalSchemas } from './fiscal-resources.js';
import { loadFiscalWorkerConfig } from './worker-config.js';
import { runWorker } from './worker-runtime.js';

/**
 * worker-fiscal (ADR-0021): único processo com a KEK privada dos certificados. Consome só a
 * lane `fiscal` (RLS da tabela de jobs). Não faz requisições a URLs de terceiros.
 */
const config = loadFiscalWorkerConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'worker-fiscal' });
const database = createDatabase({ url: config.WORKER_DATABASE_URL, poolMax: config.WORKER_CONCURRENCY + 2, statementTimeoutMs: 30_000, applicationName: 'orbita-nfe-worker-fiscal' });

const nfse =
  config.NFSE_GATEWAY === 'simulator'
    ? { gateway: new SimulatedNfseGateway(), preparer: new XmlDpsPreparer(loadFiscalSchemas(), `orbita-nfe-${config.APP_VERSION}`) }
    : undefined;
if (nfse !== undefined) logger.warn('NFS-e com autorizador SIMULADO (NFSE_GATEWAY=simulator): nada é enviado a órgão nenhum');

const { handlers } = composeFiscalWorker({
  db: database.db,
  certificateKeks: [loadPrivateKek(config.WORKER_CERTIFICATE_KEK_PRIVATE_FILE)],
  trustStore: X509TrustStore.fromFile(config.CERTIFICATE_TRUST_BUNDLE_FILE),
  ...(nfse === undefined ? {} : { nfse }),
});

runWorker({
  lane: 'fiscal',
  database,
  handlers,
  logger,
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  retentionDays: config.JOB_RETENTION_DAYS,
});
