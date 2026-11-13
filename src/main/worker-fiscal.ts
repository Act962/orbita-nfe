import { loadPrivateKek, X509TrustStore } from '../modules/certificates/public.js';
import {
  NationalNfseGateway,
  SEFIN_NACIONAL,
  SimulatedNfseGateway,
  XmlCancellationPreparer,
  XmlDpsPreparer,
  XmlNfseVerifier,
  type UnknownAlertSink,
} from '../modules/nfse/public.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { composeFiscalWorker } from './compose.js';
import { loadFiscalSchemas } from './fiscal-resources.js';
import { loadFiscalWorkerConfig } from './worker-config.js';
import { runWorker } from './worker-runtime.js';

/**
 * worker-fiscal (ADR-0021): único processo com a KEK privada dos certificados. Consome só a
 * lane `fiscal` (RLS da tabela de jobs). A única saída de rede é o autorizador fiscal
 * (NFSE_GATEWAY=sefin), com mTLS e o certificado do estabelecimento; nunca URLs de clientes.
 */
const config = loadFiscalWorkerConfig();
const logger = createLogger({ level: config.LOG_LEVEL, service: 'worker-fiscal' });
const database = createDatabase({ url: config.WORKER_DATABASE_URL, poolMax: config.WORKER_CONCURRENCY + 2, statementTimeoutMs: 30_000, applicationName: 'orbita-nfe-worker-fiscal' });

/**
 * Alertas de NFS-e em UNKNOWN pela idade (doc 12 §6): log estruturado com o evento
 * `nfse.unknown_age`, só identificadores. WARNING → warn; CRITICAL e INCIDENT → error.
 */
const alerts: UnknownAlertSink = {
  raise: (alert) => {
    const line = { event: 'nfse.unknown_age', ...alert };
    if (alert.level === 'WARNING') logger.warn(line, 'NFS-e em UNKNOWN há mais de 15 min');
    else logger.error(line, alert.level === 'CRITICAL' ? 'NFS-e em UNKNOWN há mais de 2 h' : 'INCIDENTE: NFS-e em UNKNOWN há mais de 24 h; análise manual obrigatória');
  },
};

const schemas = config.NFSE_GATEWAY === 'none' ? undefined : loadFiscalSchemas();
const nfse =
  schemas === undefined
    ? undefined
    : {
        gateway: config.NFSE_GATEWAY === 'sefin' ? new NationalNfseGateway(SEFIN_NACIONAL) : new SimulatedNfseGateway(),
        preparer: new XmlDpsPreparer(schemas, `orbita-nfe-${config.APP_VERSION}`),
        verifier: new XmlNfseVerifier(schemas),
        alerts,
        cancellationPreparer: new XmlCancellationPreparer(schemas, `orbita-nfe-${config.APP_VERSION}`),
      };
if (config.NFSE_GATEWAY === 'simulator') logger.warn('NFS-e com autorizador SIMULADO (NFSE_GATEWAY=simulator): nada é enviado a órgão nenhum');
if (config.NFSE_GATEWAY === 'sefin') logger.warn({ endpoints: SEFIN_NACIONAL.baseUrls }, 'NFS-e com a SEFIN Nacional REAL (NFSE_GATEWAY=sefin): só a produção restrita está configurada');

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
