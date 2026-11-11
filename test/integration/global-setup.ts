import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
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
      adminUrl: string;
    };
    /** S3 local com Object Lock (SeaweedFS, a mesma imagem do docker-compose) para as âncoras. */
    objectStorage: { endpoint: string; anchorBucket: string };
  }
}

let container: StartedPostgreSqlContainer | undefined;
let storage: StartedTestContainer | undefined;

export const TEST_S3_CREDENTIALS = { accessKeyId: 'test-only', secretAccessKey: 'test-only' };

/** Sobe o SeaweedFS e cria o bucket de âncoras COM Object Lock (como em produção). */
async function startObjectStorage(): Promise<{ endpoint: string; anchorBucket: string }> {
  storage = await new GenericContainer('chrislusf/seaweedfs:4.50')
    .withCommand(['server', '-s3', '-dir=/data', '-ip.bind=0.0.0.0'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const endpoint = `http://${storage.getHost()}:${String(storage.getMappedPort(8333))}`;
  const anchorBucket = 'test-audit-anchors';
  const s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: TEST_S3_CREDENTIALS });
  try {
    // O gateway S3 aceita conexão um pouco antes de estar pronto: tenta por até 60 s.
    for (let attempt = 0; ; attempt++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: anchorBucket, ObjectLockEnabledForBucket: true }));
        break;
      } catch (error) {
        if (attempt >= 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    s3.destroy();
  }
  return { endpoint, anchorBucket };
}

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
    adminUrl: urlFor('app_admin'),
  });
  project.provide('objectStorage', await startObjectStorage());

  return async () => {
    await storage?.stop();
    await container?.stop();
  };
}
