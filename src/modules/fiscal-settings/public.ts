/**
 * Fachada pública do módulo Fiscal Settings.
 */
export { FiscalSettingsService, requireAllocated, type EstablishmentDirectory } from './application/fiscal-settings-service.js';
export type { DocumentKind, DocumentSeries, FiscalEnvironment, NumberAllocation } from './domain/document-series.js';
export { documentSeriesRepository, fiscalSettingsUnitOfWork, FISCAL_SETTINGS_CONSTRAINTS } from './infrastructure/persistence/repositories.js';
export { registerFiscalSettingsRoutes } from './presentation/http/routes.js';
