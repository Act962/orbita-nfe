/**
 * Fachada pública do módulo Company. Outros módulos e o composition root só importam daqui.
 */
export { CompanyService, establishmentNotFound, type AccessGrants } from './application/company-service.js';
export type { Establishment, Company } from './domain/company.js';
export { companyRepository, establishmentRepository, companyUnitOfWork, COMPANY_CONSTRAINTS } from './infrastructure/persistence/repositories.js';
export { registerCompanyRoutes } from './presentation/http/routes.js';
