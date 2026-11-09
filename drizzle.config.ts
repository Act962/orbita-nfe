import { defineConfig } from 'drizzle-kit';

/**
 * Migrations versionadas e revisadas (ADR-0004). Fluxo:
 * 1. alterar o schema do módulo;
 * 2. `npm run db:generate -- --name=<descricao>` e REVISAR o SQL gerado;
 * 3. segurança (papéis, grants, RLS) em migration SQL explícita: `npm run db:generate:custom -- --name=<descricao>`.
 * As migrations rodam com o papel dono das tabelas (MIGRATION_DATABASE_URL), nunca com o da aplicação.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env['MIGRATION_DATABASE_URL'] ?? '' },
});
