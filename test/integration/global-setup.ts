import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';
import { bootstrapDatabase, createLoginUsers, TEST_LOGIN_PASSWORD } from './support/bootstrap.js';

/**
 * PostgreSQL real para os testes de integração (Testcontainers).
 * Reproduz a topologia de produção (docs/runbooks/bootstrap-banco.md):
 * - superusuário só faz o bootstrap;
 * - migrations rodam com um dono de tabelas SEM superuser (assim o FORCE RLS vale para ele);
 * - a aplicação conecta com usuários de login membros de fiscal_api / fiscal_worker / fiscal_general.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    database: {
      superuserUrl: string;
      ownerUrl: string;
      apiUrl: string;
      workerUrl: string;
      generalUrl: string;
    };
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('orbita_nfe')
    .withUsername('superuser_test')
    .withPassword(TEST_LOGIN_PASSWORD)
    .start();

  const superuserUrl = container.getConnectionUri();
  const urlFor = (user: string): string => {
    const url = new URL(superuserUrl);
    url.username = user;
    url.password = TEST_LOGIN_PASSWORD;
    return url.toString();
  };

  const admin = new pg.Client({ connectionString: superuserUrl });
  await admin.connect();
  try {
    await bootstrapDatabase(admin);
    await runMigrations(urlFor('fiscal_owner'));
    await createLoginUsers(admin);
  } finally {
    await admin.end();
  }

  project.provide('database', {
    superuserUrl,
    ownerUrl: urlFor('fiscal_owner'),
    apiUrl: urlFor('app_api'),
    workerUrl: urlFor('app_worker'),
    generalUrl: urlFor('app_general'),
  });

  return async () => {
    await container?.stop();
  };
}
