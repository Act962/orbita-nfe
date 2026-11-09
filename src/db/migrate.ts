import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Aplica as migrations pendentes com o papel DONO das tabelas (nunca o da aplicação).
 * Usado no job de deploy (Coolify) e pelos testes de integração.
 */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1, application_name: 'orbita-nfe-migrations' });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

// Execução direta: `npm run db:migrate` (lê MIGRATION_DATABASE_URL).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env['MIGRATION_DATABASE_URL'];
  if (url === undefined || url === '') {
    process.stderr.write('MIGRATION_DATABASE_URL não definida\n');
    process.exit(1);
  }
  runMigrations(url).then(
    () => {
      process.stdout.write('migrations aplicadas\n');
    },
    (error: unknown) => {
      // Só o código: a mensagem do driver pode conter dados.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN';
      process.stderr.write(`falha ao aplicar migrations (código ${code})\n`);
      process.exit(1);
    },
  );
}
