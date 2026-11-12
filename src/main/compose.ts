import type { KeyObject } from 'node:crypto';
import {
  AuditAnchorer,
  AuditVerifier,
  DrizzleAuditChainReader,
  anchorHeadReader,
  companyAuditTrail,
  platformAuditTrail,
  sha256ChainHasher,
  type AnchorStore,
} from '../modules/audit/public.js';
import {
  CertificateExpiryNotifier,
  CertificateService,
  CertificateVault,
  ForgePkcs12Reader,
  RsaEnvelopeOpener,
  RsaEnvelopeSealer,
  certificateApiUnitOfWork,
  certificateAvailability,
  certificateExpiryUnitOfWork,
  certificateWorkerUnitOfWork,
  registerCertificateRoutes,
  type CompanyLookup,
  type EstablishmentLookup,
  type TrustStore,
} from '../modules/certificates/public.js';
import { companyRepository, establishmentRepository, registerCompanyRoutes, CompanyService, companyUnitOfWork } from '../modules/company/public.js';
import {
  FiscalSettingsService,
  documentSeriesRepository,
  fiscalSettingsUnitOfWork,
  productionEnablementRepository,
  registerFiscalSettingsRoutes,
  requireAllocated,
  type EstablishmentDirectory,
  type EstablishmentProfiles,
} from '../modules/fiscal-settings/public.js';
import {
  Reconciler,
  ServiceInvoiceService,
  SubmissionProcessor,
  nfseApiUnitOfWork,
  nfseWorkerUnitOfWork,
  type CredentialAccess,
  type DpsPreparer,
  type EstablishmentReader,
  type NfseGateway,
  type ProcessorOptions,
  type ProductionGate,
  type SeriesAllocator,
} from '../modules/nfse/public.js';
import {
  AccessControl,
  DrizzleCredentialLookup,
  DrizzleIamAdminStore,
  DrizzleCompanyAccessLookup,
  HmacSecretHasher,
  IamAdmin,
  RandomKeyMaterial,
  registerAuthentication,
  companyGrantWriter,
} from '../modules/iam/public.js';
import {
  HttpWebhookSender,
  RsaSecretOpener,
  RsaSecretSealer,
  WebhookDispatcher,
  WebhookService,
  randomSecretGenerator,
  registerWebhookRoutes,
  standardWebhookSigner,
  webhookApiUnitOfWork,
  webhookDispatcherUnitOfWork,
} from '../modules/webhooks/public.js';
import type { AuditContext } from '../shared/application/audit.js';
import { PermanentJobError, type ClaimedJob, type JobHandler, type JobLane, type JobScheduler, type QueueName } from '../shared/application/job-queue.js';
import type { EventOutbox } from '../shared/application/outbox.js';
import { nextDailyRun, runDay } from '../shared/domain/daily-schedule.js';
import type { BucketPolicy } from '../shared/domain/token-bucket.js';
import { CompanyTransactions, type Database, type Transaction } from '../shared/infrastructure/database/database.js';
import { uuidv7 } from '../shared/infrastructure/ids.js';
import { companyEventOutbox } from '../shared/infrastructure/outbox/outbox-store.js';
import { transactionalJobScheduler } from '../shared/infrastructure/queue/postgres-queue.js';
import { QueueAdmin } from '../shared/infrastructure/queue/queue-admin.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';
import { RateLimiter } from '../shared/presentation/http/rate-limit.js';

const establishmentDirectory = (tx: Transaction): EstablishmentDirectory & EstablishmentProfiles & EstablishmentLookup => ({
  exists: async (id) => (await establishmentRepository(tx).findById(id)) !== undefined,
  profile: async (id) => {
    const found = await establishmentRepository(tx).findById(id);
    return found === undefined ? undefined : { cnpj: found.cnpj, status: found.status };
  },
});

const companyLookup = (tx: Transaction): CompanyLookup => ({
  currentRootCnpj: async () => (await companyRepository(tx).current())?.rootCnpj,
});

const auditFor = (tx: Transaction) => companyAuditTrail(tx, { newId: uuidv7 });

// Portas da NFS-e implementadas pelos módulos company e fiscal-settings (só pelo public.ts).
const nfseEstablishments = (tx: Transaction): EstablishmentReader => ({
  find: async (id) => {
    const found = await establishmentRepository(tx).findById(id);
    return found === undefined ? undefined : { id: found.id, cnpj: found.cnpj, municipalityCode: found.municipalityCode, status: found.status };
  },
});
const nfseSeries = (tx: Transaction): SeriesAllocator => ({
  activeSeries: async (establishmentId, environment) =>
    (await documentSeriesRepository(tx).listByEstablishment(establishmentId))
      .filter((s) => s.kind === 'NFSE_DPS' && s.environment === environment && s.status === 'ACTIVE')
      .map((s) => ({ id: s.id, series: s.series })),
  allocate: async (seriesId) => requireAllocated(await documentSeriesRepository(tx).allocateNext(seriesId)),
});
const nfseProduction = (tx: Transaction): ProductionGate => ({
  isEnabled: (establishmentId) => productionEnablementRepository(tx).isEnabled(establishmentId, 'NFSE_DPS'),
});
/** Agendador de jobs do processo: só absorve repetição de chave na lane que ele consome (ADR-0030). */
const schedulerFor =
  (ownLane?: JobLane) =>
  (tx: Transaction): JobScheduler =>
    transactionalJobScheduler(tx, uuidv7, ownLane);
const outboxWith =
  (jobs: (tx: Transaction) => JobScheduler) =>
  (tx: Transaction): EventOutbox =>
    companyEventOutbox(tx, { newId: uuidv7, jobs: jobs(tx) });

const apiJobs = schedulerFor();
const apiOutbox = outboxWith(apiJobs);

export interface ApiModulesDependencies {
  /** Conexão do papel fiscal_api. */
  readonly db: Database;
  readonly apiKeyPepper: Uint8Array;
  /** KEK PÚBLICA dos certificados: a API cifra, mas não consegue decifrar (ADR-0009). */
  readonly certificateKek: KeyObject;
  /** Chave PÚBLICA dos segredos de webhook: a API cifra, só o worker-general decifra (ADR-0021). */
  readonly webhookSecretKey: KeyObject;
  readonly rateLimit: { readonly perCredential: BucketPolicy; readonly perAddress: BucketPolicy };
  /** Só desenvolvimento e testes (a config recusa em produção). */
  readonly allowPrivateWebhookTargets: boolean;
}

export interface ApiModules {
  readonly company: CompanyService;
  readonly nfse: ServiceInvoiceService;
  readonly fiscalSettings: FiscalSettingsService;
  readonly certificates: CertificateService;
  readonly webhooks: WebhookService;
  readonly registerRoutes: (app: HttpApp) => void;
}

/** Composition root da API: liga as portas dos módulos às implementações. */
export function composeApi(deps: ApiModulesDependencies): ApiModules {
  if (deps.certificateKek.type !== 'public') throw new Error('a API só pode receber a KEK pública dos certificados');
  if (deps.webhookSecretKey.type !== 'public') throw new Error('a API só pode receber a chave pública dos segredos de webhook');
  const transactions = new CompanyTransactions(deps.db);
  const accessControl = new AccessControl(
    new DrizzleCredentialLookup(deps.db),
    new HmacSecretHasher(deps.apiKeyPepper),
    new DrizzleCompanyAccessLookup(transactions),
  );
  const company = new CompanyService(companyUnitOfWork(transactions, companyGrantWriter, auditFor, apiJobs), uuidv7);
  const fiscalSettings = new FiscalSettingsService(
    fiscalSettingsUnitOfWork(transactions, { establishmentsFor: establishmentDirectory, certificatesFor: certificateAvailability, auditFor }),
    uuidv7,
  );
  const certificates = new CertificateService(
    certificateApiUnitOfWork(transactions, { establishmentsFor: establishmentDirectory, auditFor, jobsFor: apiJobs, outboxFor: apiOutbox }),
    new RsaEnvelopeSealer(deps.certificateKek),
    uuidv7,
  );
  const webhooks = new WebhookService(
    webhookApiUnitOfWork(transactions, { auditFor, jobsFor: apiJobs, outboxFor: apiOutbox }),
    new RsaSecretSealer(deps.webhookSecretKey),
    randomSecretGenerator,
    uuidv7,
    { allowPrivateTargets: deps.allowPrivateWebhookTargets },
  );
  const nfse = new ServiceInvoiceService(
    nfseApiUnitOfWork(transactions, {
      establishmentsFor: nfseEstablishments,
      seriesFor: nfseSeries,
      productionFor: nfseProduction,
      auditFor,
      jobsFor: apiJobs,
    }),
    uuidv7,
  );
  const rateLimiter = new RateLimiter(deps.rateLimit);

  return {
    company,
    nfse,
    fiscalSettings,
    certificates,
    webhooks,
    registerRoutes: (app) => {
      rateLimiter.beforeAuthentication(app);
      registerAuthentication(app, accessControl);
      rateLimiter.afterAuthentication(app);
      registerCompanyRoutes(app, company);
      registerFiscalSettingsRoutes(app, fiscalSettings);
      registerCertificateRoutes(app, certificates);
      registerWebhookRoutes(app, webhooks);
    },
  };
}

/** Lê do payload um id obrigatório; ausente = job malformado, não adianta repetir. */
function payloadId(job: ClaimedJob, key: string): string {
  const value = job.payload[key];
  if (value === undefined) throw new PermanentJobError('JOB_PAYLOAD_INVALID');
  return value;
}

const systemContext = (process: string, job: ClaimedJob): AuditContext => ({ actor: { kind: 'SYSTEM', process }, correlationId: job.correlationId });

export interface FiscalWorkerDependencies {
  /** Conexão do papel fiscal_worker. */
  readonly db: Database;
  /** KEKs PRIVADAS (a atual e, durante a rotação, as anteriores). Só o worker-fiscal as tem. */
  readonly certificateKeks: readonly KeyObject[];
  /** ACs raiz confiáveis (bundle ICP-Brasil versionado). */
  readonly trustStore: TrustStore;
  /**
   * Emissão de NFS-e (ADR-0032). Sem isto, as filas `nfse.*` ficam sem handler. Nesta etapa o
   * gateway disponível é o simulador, e a configuração o recusa em produção.
   */
  readonly nfse?: { readonly gateway: NfseGateway; readonly preparer: DpsPreparer; readonly options?: ProcessorOptions };
  readonly now?: () => Date;
}

/** Composition root do worker-fiscal (validação e uso de certificados). */
export function composeFiscalWorker(deps: FiscalWorkerDependencies): {
  vault: CertificateVault;
  processor?: SubmissionProcessor;
  reconciler?: Reconciler;
  handlers: Partial<Record<QueueName, JobHandler>>;
} {
  const transactions = new CompanyTransactions(deps.db);
  const vault = new CertificateVault(
    certificateWorkerUnitOfWork(transactions, {
      companyFor: companyLookup,
      auditFor,
      outboxFor: outboxWith(schedulerFor('fiscal')),
      jobsFor: schedulerFor('fiscal'),
    }),
    new RsaEnvelopeOpener(deps.certificateKeks),
    new ForgePkcs12Reader(),
    deps.trustStore,
    deps.now,
  );
  const handlers: Partial<Record<QueueName, JobHandler>> = {
    'certificates.validate': async (job) => {
      await vault.validate(payloadId(job, 'companyId'), payloadId(job, 'certificateId'), systemContext('worker-fiscal', job));
    },
  };
  if (deps.nfse === undefined) return { vault, handlers };

  const credentials: CredentialAccess = {
    withCredential: (companyId, establishmentId, work) =>
      vault.withCertificate(companyId, establishmentId, (certificate) => work({ privateKey: certificate.privateKey, certificatePem: certificate.certificatePem })),
  };
  const nfseUow = nfseWorkerUnitOfWork(transactions, {
    productionFor: nfseProduction,
    auditFor,
    jobsFor: schedulerFor('fiscal'),
    outboxFor: outboxWith(schedulerFor('fiscal')),
  });
  const processor = new SubmissionProcessor(nfseUow, credentials, deps.nfse.preparer, deps.nfse.gateway, uuidv7, deps.now, deps.nfse.options);
  const reconciler = new Reconciler(nfseUow, credentials, deps.nfse.gateway, deps.now, deps.nfse.options?.reconciliation);
  handlers['nfse.process'] = async (job) => {
    const result = await processor.process(payloadId(job, 'companyId'), payloadId(job, 'invoiceId'), systemContext('worker-fiscal', job));
    // Falha local numa retransmissão: o job tenta de novo com backoff (nunca FAILED depois de um envio).
    if (result.kind === 'DEFERRED') throw new Error(`NFSE_PROCESSING_DEFERRED:${result.code}`);
  };
  handlers['nfse.reconcile'] = async (job) => {
    await reconciler.reconcile(payloadId(job, 'companyId'), payloadId(job, 'invoiceId'), systemContext('worker-fiscal', job));
  };
  return { vault, processor, reconciler, handlers };
}

export interface GeneralWorkerDependencies {
  /** Conexão do papel fiscal_general. */
  readonly db: Database;
  /** Chaves PRIVADAS dos segredos de webhook (a atual e as anteriores, na rotação). */
  readonly webhookSecretKeys: readonly KeyObject[];
  readonly allowPrivateWebhookTargets: boolean;
  readonly webhookTimeoutMs: number;
  /** Bucket com Object Lock das âncoras de auditoria (ADR-0031). Sem ele, as filas de âncora ficam paradas. */
  readonly anchorStore?: AnchorStore;
  readonly now?: () => Date;
}

/** Composition root do worker-general (outbox e entrega de webhooks). Nunca recebe material de certificado. */
export function composeGeneralWorker(deps: GeneralWorkerDependencies): {
  dispatcher: WebhookDispatcher;
  expiry: CertificateExpiryNotifier;
  handlers: Partial<Record<QueueName, JobHandler>>;
  /** Garante a âncora diária da plataforma (idempotente); chamar na inicialização. */
  ensureRecurringJobs: () => Promise<void>;
  close: () => Promise<void>;
} {
  const transactions = new CompanyTransactions(deps.db);
  const sender = new HttpWebhookSender({ allowPrivateTargets: deps.allowPrivateWebhookTargets, timeoutMs: deps.webhookTimeoutMs });
  const dispatcher = new WebhookDispatcher(
    webhookDispatcherUnitOfWork(transactions, { jobsFor: schedulerFor('general') }),
    new RsaSecretOpener(deps.webhookSecretKeys),
    standardWebhookSigner,
    sender,
    uuidv7,
    deps.now,
  );
  const expiry = new CertificateExpiryNotifier(certificateExpiryUnitOfWork(transactions, { outboxFor: outboxWith(schedulerFor('general')) }), deps.now);
  const now = deps.now ?? (() => new Date());
  // Fora de transação de empresa: o job só carrega ids e a fila é da plataforma (lane general).
  const generalJobs = transactionalJobScheduler(deps.db, uuidv7, 'general');
  const scheduleNextAnchor = async (job: ClaimedJob, chain: { companyId: string } | null): Promise<void> => {
    const next = nextDailyRun(now());
    await generalJobs.enqueue(
      chain === null
        ? { queue: 'audit.anchor-platform', payload: {}, singletonKey: `platform:${runDay(next)}`, runAt: next, correlationId: job.correlationId }
        : { queue: 'audit.anchor-company', payload: { companyId: chain.companyId }, singletonKey: `${chain.companyId}:${runDay(next)}`, runAt: next, correlationId: job.correlationId },
    );
  };
  const anchorHandlers: Partial<Record<QueueName, JobHandler>> = {};
  if (deps.anchorStore !== undefined) {
    const anchorer = new AuditAnchorer(anchorHeadReader(deps.db, (companyId, work) => transactions.run(companyId, work)), deps.anchorStore, now);
    anchorHandlers['audit.anchor-company'] = async (job) => {
      const companyId = payloadId(job, 'companyId');
      await scheduleNextAnchor(job, { companyId });
      await anchorer.anchor({ kind: 'COMPANY', companyId });
    };
    anchorHandlers['audit.anchor-platform'] = async (job) => {
      await scheduleNextAnchor(job, null);
      await anchorer.anchor({ kind: 'PLATFORM' });
    };
  }
  return {
    dispatcher,
    expiry,
    ensureRecurringJobs: async () => {
      if (deps.anchorStore === undefined) return;
      const next = nextDailyRun(now());
      await generalJobs.enqueue({ queue: 'audit.anchor-platform', payload: {}, singletonKey: `platform:${runDay(next)}`, runAt: next });
    },
    handlers: {
      ...anchorHandlers,
      'certificates.expiry-notice': async (job) => {
        await expiry.notify(payloadId(job, 'companyId'), payloadId(job, 'certificateId'), job.correlationId);
      },
      'webhooks.fanout': async (job) => {
        await dispatcher.fanout(payloadId(job, 'companyId'), payloadId(job, 'eventId'));
      },
      'webhooks.deliver': async (job, signal) => {
        await dispatcher.attempt(payloadId(job, 'companyId'), payloadId(job, 'deliveryId'), signal);
      },
    },
    close: () => sender.close(),
  };
}

/** Composition root da CLI do operador (conexão do papel fiscal_admin). */
export function composeIamAdmin(deps: { db: Database; apiKeyPepper: Uint8Array }): IamAdmin {
  const transactions = new CompanyTransactions(deps.db);
  const store = new DrizzleIamAdminStore(deps.db, transactions, {
    platform: (tx) => platformAuditTrail(tx, { newId: uuidv7 }),
    company: auditFor,
  });
  return new IamAdmin(store, new HmacSecretHasher(deps.apiKeyPepper), new RandomKeyMaterial(), uuidv7);
}

/** Operação das filas pelo operador (papel fiscal_admin). */
export function composeQueueAdmin(deps: { db: Database }): QueueAdmin {
  return new QueueAdmin(deps.db, (tx) => platformAuditTrail(tx, { newId: uuidv7 }));
}

/** Verificação das cadeias de auditoria (operador, papel fiscal_admin). */
export function composeAuditVerifier(deps: { db: Database }): AuditVerifier {
  const transactions = new CompanyTransactions(deps.db);
  return new AuditVerifier(new DrizzleAuditChainReader(deps.db, (companyId, work) => transactions.run(companyId, work)), sha256ChainHasher);
}
