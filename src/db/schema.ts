/**
 * Agregador de schemas Drizzle de todos os módulos, usado apenas pelo drizzle-kit para gerar
 * migrations. O código da aplicação importa o schema do próprio módulo.
 */
export * from '../modules/company/infrastructure/persistence/schema.js';
export * from '../modules/iam/infrastructure/persistence/schema.js';
export * from '../modules/fiscal-settings/infrastructure/persistence/schema.js';
