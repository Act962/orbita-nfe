/**
 * Fachada pública do módulo Fiscal Settings.
 */
export {
  FiscalSettingsService,
  requireAllocated,
  type CertificateAvailability,
  type EstablishmentDirectory,
  type EstablishmentProfiles,
  type ProductionEnablementRepository,
} from './application/fiscal-settings-service.js';
export type { ProductionEnablement } from './domain/production-enablement.js';
export type { DocumentKind, DocumentSeries, FiscalEnvironment, NumberAllocation } from './domain/document-series.js';
export { documentSeriesRepository, fiscalSettingsUnitOfWork, productionEnablementRepository, FISCAL_SETTINGS_CONSTRAINTS } from './infrastructure/persistence/repositories.js';
export { registerFiscalSettingsRoutes } from './presentation/http/routes.js';
