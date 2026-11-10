import type { KeyObject } from 'node:crypto';
import { AuditVerifier, DrizzleAuditChainReader, companyAuditTrail, platformAuditTrail, sha256ChainHasher } from '../modules/audit/public.js';
import {
  CertificateService,
  CertificateVault,
  ForgePkcs12Reader,
  RsaEnvelopeOpener,
  RsaEnvelopeSealer,
  certificateApiUnitOfWork,
  certificateWorkerUnitOfWork,
  registerCertificateRoutes,
  type CompanyLookup,
  type EstablishmentLookup,
  type TrustStore,
} from '../modules/certificates/public.js';
import { companyRepository, establishmentRepository, registerCompanyRoutes, CompanyService, companyUnitOfWork } from '../modules/company/public.js';
import {
  FiscalSettingsService,
  fiscalSettingsUnitOfWork,
  registerFiscalSettingsRoutes,
  type EstablishmentDirectory,
} from '../modules/fiscal-settings/public.js';
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
import type { BucketPolicy } from '../shared/domain/token-bucket.js';
import { CompanyTransactions, type Database, type Transaction } from '../shared/infrastructure/database/database.js';
import { uuidv7 } from '../shared/infrastructure/ids.js';
import { companyEventOutbox } from '../shared/infrastructure/outbox/outbox-store.js';
import { transactionalJobScheduler } from '../shared/infrastructure/queue/postgres-queue.js';
import { QueueAdmin } from '../shared/infrastructure/queue/queue-admin.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';
import { RateLimiter } from '../shared/presentation/http/rate-limit.js';

const establishmentDirectory = (tx: Transaction): EstablishmentDirectory & EstablishmentLookup => ({
  exists: async (id) => (await establishmentRepository(tx).findById(id)) !== undefined,
});

const companyLookup = (tx: Transaction): CompanyLookup => ({
  currentRootCnpj: async () => (await companyRepository(tx).current())?.rootCnpj,
});

const auditFor = (tx: Transaction) => companyAuditTrail(tx, { newId: uuidv7 });
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
  const company = new CompanyService(companyUnitOfWork(transactions, companyGrantWriter, auditFor), uuidv7);
  const fiscalSettings = new FiscalSettingsService(fiscalSettingsUnitOfWork(transactions, establishmentDirectory, auditFor), uuidv7);
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
  const rateLimiter = new RateLimiter(deps.rateLimit);

  return {
    company,
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
  readonly now?: () => Date;
}

/** Composition root do worker-fiscal (validação e uso de certificados). */
export function composeFiscalWorker(deps: FiscalWorkerDependencies): { vault: CertificateVault; handlers: Partial<Record<QueueName, JobHandler>> } {
  const transactions = new CompanyTransactions(deps.db);
  const vault = new CertificateVault(
    certificateWorkerUnitOfWork(transactions, { companyFor: companyLookup, auditFor, outboxFor: outboxWith(schedulerFor('fiscal')) }),
    new RsaEnvelopeOpener(deps.certificateKeks),
    new ForgePkcs12Reader(),
    deps.trustStore,
    deps.now,
  );
  return {
    vault,
    handlers: {
      'certificates.validate': async (job) => {
        await vault.validate(payloadId(job, 'companyId'), payloadId(job, 'certificateId'), systemContext('worker-fiscal', job));
      },
    },
  };
}

export interface GeneralWorkerDependencies {
  /** Conexão do papel fiscal_general. */
  readonly db: Database;
  /** Chaves PRIVADAS dos segredos de webhook (a atual e as anteriores, na rotação). */
  readonly webhookSecretKeys: readonly KeyObject[];
  readonly allowPrivateWebhookTargets: boolean;
  readonly webhookTimeoutMs: number;
  readonly now?: () => Date;
}

/** Composition root do worker-general (outbox e entrega de webhooks). Nunca recebe material de certificado. */
export function composeGeneralWorker(deps: GeneralWorkerDependencies): {
  dispatcher: WebhookDispatcher;
  handlers: Partial<Record<QueueName, JobHandler>>;
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
  return {
    dispatcher,
    handlers: {
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
