import { loadPrivateKek, X509TrustStore } from '../modules/certificates/public.js';
import {
  ChannelRoutedGateway,
  NationalNfseGateway,
  S3ArtifactStore,
  SEFIN_NACIONAL,
  SimulatedNfseGateway,
  TERESINA_DSF,
  XmlCancellationPreparer,
  XmlDpsPreparer,
  XmlNfseVerifier,
  type ArchiveIntegrityAlertSink,
  type UnknownAlertSink,
} from '../modules/nfse/public.js';
import { PI_QR_CODE_URL, qrCodeV3Online, SimulatedNfceAuthorizer, XmlNfcePreparer } from '../modules/nfce/public.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { createLogger } from '../shared/infrastructure/logging/logger.js';
import { artifactArchiveOptions } from './artifact-config.js';
import { composeFiscalWorker } from './compose.js';
import { loadFiscalSchemas, loadMunicipalities } from './fiscal-resources.js';
import { loadFiscalWorkerConfig } from './worker-config.js';
import { runWorker } from './worker-runtime.js';

/**
 * worker-fiscal (ADR-0021): único processo com a KEK privada dos certificados. Consome só a
 * lane `fiscal` (RLS da tabela de jobs). As saídas de rede são os autorizadores fiscais
 * (NFSE_GATEWAY=real), com mTLS e o certificado do estabelecimento, e o bucket de artefatos
 * (ADR-0048); nunca URLs de clientes.
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

/**
 * Falha da conferência periódica dos XML arquivados (ADR-0051): log de erro com o evento
 * `nfse.archive_integrity`, só identificadores e o código. Repete uma vez por dia até ser resolvida.
 */
const archiveAlerts: ArchiveIntegrityAlertSink = {
  raise: (alert) => {
    logger.error({ event: 'nfse.archive_integrity', ...alert }, 'XML arquivado não confere com o hash ou a trava gravados; análise manual obrigatória');
  },
};

const archiveOptions = artifactArchiveOptions(config);
const artifactStore = archiveOptions === undefined ? undefined : new S3ArtifactStore(archiveOptions.store);
if (artifactStore === undefined && config.NFSE_GATEWAY !== 'none') {
  logger.warn('arquivamento do XML autorizado não configurado: fila nfse.archive parada (só fora de produção)');
}

const schemas = config.NFSE_GATEWAY === 'none' ? undefined : loadFiscalSchemas();
const nfse =
  schemas === undefined
    ? undefined
    : {
        gateway:
          config.NFSE_GATEWAY === 'real'
            ? new ChannelRoutedGateway({ NATIONAL_SEFIN: new NationalNfseGateway(SEFIN_NACIONAL), MUNICIPAL_TERESINA_DSF: new NationalNfseGateway(TERESINA_DSF) })
            : new SimulatedNfseGateway(),
        preparer: new XmlDpsPreparer(schemas, `orbita-nfe-${config.APP_VERSION}`),
        verifier: new XmlNfseVerifier(schemas),
        alerts,
        cancellationPreparer: new XmlCancellationPreparer(schemas, `orbita-nfe-${config.APP_VERSION}`),
        ...(artifactStore === undefined || archiveOptions === undefined ? {} : { archive: { store: artifactStore, retentionDays: archiveOptions.retentionDays, alerts: archiveAlerts } }),
      };
if (config.NFSE_GATEWAY === 'simulator') logger.warn('NFS-e com autorizador SIMULADO (NFSE_GATEWAY=simulator): nada é enviado a órgão nenhum');
if (config.NFSE_GATEWAY === 'real') {
  logger.warn({ sefin: SEFIN_NACIONAL.baseUrls, teresinaDsf: TERESINA_DSF.baseUrls }, 'NFS-e com autorizadores REAIS (NFSE_GATEWAY=real): só os ambientes de homologação estão configurados');
}

/**
 * NFC-e (ADR-0072): só o simulador nesta etapa. A versão do QR Code (ADR-0066) e a `urlChave` do PI
 * ainda são decisões em aberto: o simulador usa o QR Code 3.00 e um endereço `.invalid`.
 */
const nfce =
  config.NFCE_GATEWAY === 'none'
    ? undefined
    : {
        gateway: new SimulatedNfceAuthorizer(),
        preparer: new XmlNfcePreparer(
          schemas ?? loadFiscalSchemas(),
          { qrCode: ({ accessKey, environment }) => qrCodeV3Online({ baseUrl: PI_QR_CODE_URL, accessKey, environment }), consultationUrl: 'https://consulta.exemplo.invalid/nfce' },
          `orbita-nfe-${config.APP_VERSION}`,
        ),
        municipalities: loadMunicipalities(),
        ...(artifactStore === undefined || archiveOptions === undefined ? {} : { archive: { store: artifactStore, retentionDays: archiveOptions.retentionDays } }),
      };
if (config.NFCE_GATEWAY === 'simulator') logger.warn('NFC-e com autorizador SIMULADO (NFCE_GATEWAY=simulator): nada é enviado a órgão nenhum');

const { handlers } = composeFiscalWorker({
  db: database.db,
  certificateKeks: [loadPrivateKek(config.WORKER_CERTIFICATE_KEK_PRIVATE_FILE)],
  trustStore: X509TrustStore.fromFile(config.CERTIFICATE_TRUST_BUNDLE_FILE),
  ...(nfse === undefined ? {} : { nfse }),
  ...(nfce === undefined ? {} : { nfce }),
});

runWorker({
  lane: 'fiscal',
  database,
  handlers,
  logger,
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  retentionDays: config.JOB_RETENTION_DAYS,
  onClose: () => {
    artifactStore?.close();
    return Promise.resolve();
  },
});
