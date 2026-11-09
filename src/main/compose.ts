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
import { establishmentRepository, registerCompanyRoutes, CompanyService, companyUnitOfWork } from '../modules/company/public.js';
import { CompanyTransactions, type Database, type Transaction } from '../shared/infrastructure/database/database.js';
import { uuidv7 } from '../shared/infrastructure/ids.js';
import type { HttpApp } from '../shared/presentation/http/http-app.js';

export interface ApiModulesDependencies {
  /** Conexão do papel fiscal_api. */
  readonly db: Database;
  readonly apiKeyPepper: Uint8Array;
}

export interface ApiModules {
  readonly company: CompanyService;
  readonly fiscalSettings: FiscalSettingsService;
  readonly registerRoutes: (app: HttpApp) => void;
}

const establishmentDirectory = (tx: Transaction): EstablishmentDirectory => ({
  exists: async (id) => (await establishmentRepository(tx).findById(id)) !== undefined,
});

/** Composition root da API: liga as portas dos módulos às implementações. */
export function composeApi(deps: ApiModulesDependencies): ApiModules {
  const transactions = new CompanyTransactions(deps.db);
  const accessControl = new AccessControl(
    new DrizzleCredentialLookup(deps.db),
    new HmacSecretHasher(deps.apiKeyPepper),
    new DrizzleCompanyAccessLookup(transactions),
  );
  const company = new CompanyService(companyUnitOfWork(transactions, companyGrantWriter), uuidv7);
  const fiscalSettings = new FiscalSettingsService(fiscalSettingsUnitOfWork(transactions, establishmentDirectory), uuidv7);

  return {
    company,
    fiscalSettings,
    registerRoutes: (app) => {
      registerAuthentication(app, accessControl);
      registerCompanyRoutes(app, company);
      registerFiscalSettingsRoutes(app, fiscalSettings);
    },
  };
}

/** Composition root da CLI do operador (conexão do papel fiscal_admin). */
export function composeIamAdmin(deps: { db: Database; apiKeyPepper: Uint8Array }): IamAdmin {
  const transactions = new CompanyTransactions(deps.db);
  return new IamAdmin(new DrizzleIamAdminStore(deps.db, transactions), new HmacSecretHasher(deps.apiKeyPepper), new RandomKeyMaterial(), uuidv7);
}
