import type pg from 'pg';

/** Senha usada apenas no container descartável dos testes. */
export const TEST_LOGIN_PASSWORD = 'integration-test-only';

/**
 * Bootstrap feito pelo superusuário UMA vez por banco (equivalente ao runbook de produção):
 * cria o dono das tabelas sem superuser e entrega a ele o schema public.
 */
export async function bootstrapDatabase(admin: pg.Client): Promise<void> {
  await admin.query(`CREATE ROLE fiscal_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${TEST_LOGIN_PASSWORD}'`);
  await admin.query('ALTER SCHEMA public OWNER TO fiscal_owner');
  await admin.query('GRANT CREATE ON DATABASE orbita_nfe TO fiscal_owner');
}

/** Usuários de login da aplicação, membros dos papéis de grupo criados pela migration. */
export async function createLoginUsers(admin: pg.Client): Promise<void> {
  const users: Array<[string, string]> = [
    ['app_api', 'fiscal_api'],
    ['app_worker', 'fiscal_worker'],
    ['app_general', 'fiscal_general'],
  ];
  for (const [user, group] of users) {
    await admin.query(`CREATE ROLE ${user} LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '${TEST_LOGIN_PASSWORD}' IN ROLE ${group}`);
  }
}
