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
import { CompanyTransactions, type Database, type Transaction } from '../shared/infrastructure/database/database.js';
import { uuidv7 } from '../shared/infrastructure/ids.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';

export interface ApiModulesDependencies {
  /** Conexão do papel fiscal_api. */
  readonly db: Database;
  readonly apiKeyPepper: Uint8Array;
  /** KEK PÚBLICA dos certificados: a API cifra, mas não consegue decifrar (ADR-0009). */
  readonly certificateKek: KeyObject;
}

export interface ApiModules {
  readonly company: CompanyService;
  readonly fiscalSettings: FiscalSettingsService;
  readonly certificates: CertificateService;
  readonly registerRoutes: (app: HttpApp) => void;
}

const establishmentDirectory = (tx: Transaction): EstablishmentDirectory & EstablishmentLookup => ({
  exists: async (id) => (await establishmentRepository(tx).findById(id)) !== undefined,
});

const companyLookup = (tx: Transaction): CompanyLookup => ({
  currentRootCnpj: async () => (await companyRepository(tx).current())?.rootCnpj,
});

const auditFor = (tx: Transaction) => companyAuditTrail(tx, { newId: uuidv7 });

/** Composition root da API: liga as portas dos módulos às implementações. */
export function composeApi(deps: ApiModulesDependencies): ApiModules {
  if (deps.certificateKek.type !== 'public') throw new Error('a API só pode receber a KEK pública dos certificados');
  const transactions = new CompanyTransactions(deps.db);
  const accessControl = new AccessControl(
    new DrizzleCredentialLookup(deps.db),
    new HmacSecretHasher(deps.apiKeyPepper),
    new DrizzleCompanyAccessLookup(transactions),
  );
  const company = new CompanyService(companyUnitOfWork(transactions, companyGrantWriter, auditFor), uuidv7);
  const fiscalSettings = new FiscalSettingsService(fiscalSettingsUnitOfWork(transactions, establishmentDirectory, auditFor), uuidv7);
  const certificates = new CertificateService(
    certificateApiUnitOfWork(transactions, { establishmentsFor: establishmentDirectory, auditFor }),
    new RsaEnvelopeSealer(deps.certificateKek),
    uuidv7,
  );

  return {
    company,
    fiscalSettings,
    certificates,
    registerRoutes: (app) => {
      registerAuthentication(app, accessControl);
      registerCompanyRoutes(app, company);
      registerFiscalSettingsRoutes(app, fiscalSettings);
      registerCertificateRoutes(app, certificates);
    },
  };
}

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
export function composeFiscalWorker(deps: FiscalWorkerDependencies): { vault: CertificateVault } {
  const transactions = new CompanyTransactions(deps.db);
  const vault = new CertificateVault(
    certificateWorkerUnitOfWork(transactions, { companyFor: companyLookup, auditFor }),
    new RsaEnvelopeOpener(deps.certificateKeks),
    new ForgePkcs12Reader(),
    deps.trustStore,
    deps.now,
  );
  return { vault };
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

/** Verificação das cadeias de auditoria (operador, papel fiscal_admin). */
export function composeAuditVerifier(deps: { db: Database }): AuditVerifier {
  const transactions = new CompanyTransactions(deps.db);
  return new AuditVerifier(new DrizzleAuditChainReader(deps.db, (companyId, work) => transactions.run(companyId, work)), sha256ChainHasher);
}
