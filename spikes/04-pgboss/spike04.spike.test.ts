import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Spike 04 — pg-boss: o enqueue participa da transação da aplicação? (ADR-0005)
 * Requer: docker compose -f docker/docker-compose.yml up -d postgres
 */
const CONNECTION = process.env['SPIKE_DATABASE_URL'] ?? 'postgres://fiscal_owner:dev-only-password@127.0.0.1:54329/orbita_nfe';
const SCHEMA = `pgboss_spike_${randomUUID().slice(0, 8)}`;
const APP_TABLE = `${SCHEMA}_documents`;
const SUBMIT = 'nfse.submit';
const DLQ = 'nfse.submit.dlq';

let pool: pg.Pool;
let boss: PgBoss;

/** Adapter: pg-boss executa o SQL no MESMO client da transação da aplicação. */
interface TransactionDb {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

function inTransaction(client: pg.PoolClient): TransactionDb {
  return { executeSql: (text: string, values?: unknown[]) => client.query(text, values) };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION, max: 10 });
  await pool.query(`CREATE TABLE ${APP_TABLE} (id uuid PRIMARY KEY, status text NOT NULL)`);
  boss = new PgBoss({ connectionString: CONNECTION, schema: SCHEMA });
  boss.on('error', () => undefined);
  await boss.start();
  await boss.createQueue(DLQ);
  await boss.createQueue(SUBMIT, { policy: 'exclusive', retryLimit: 2, retryDelay: 0, deadLetter: DLQ });
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.query(`DROP TABLE IF EXISTS ${APP_TABLE}`);
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

async function acceptDocument(commit: boolean): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO ${APP_TABLE} (id, status) VALUES ($1, 'PENDING')`, [id]);
    await boss.send(SUBMIT, { documentId: id }, { singletonKey: id, db: inTransaction(client) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
  return id;
}

async function jobsFor(queue: string, documentId: string): Promise<number> {
  const jobs = await boss.findJobs<{ documentId: string }>(queue, { data: { documentId } });
  return jobs.length;
}

describe('Spike 04 — fila transacional', () => {
  it('COMMIT: documento e job existem juntos', async () => {
    const id = await acceptDocument(true);
    expect((await pool.query(`SELECT 1 FROM ${APP_TABLE} WHERE id = $1`, [id])).rowCount).toBe(1);
    expect(await jobsFor(SUBMIT, id)).toBe(1);
  });

  it('ROLLBACK: nem documento nem job (sem dual write)', async () => {
    const id = await acceptDocument(false);
    expect((await pool.query(`SELECT 1 FROM ${APP_TABLE} WHERE id = $1`, [id])).rowCount).toBe(0);
    expect(await jobsFor(SUBMIT, id)).toBe(0);
  });

  it('política exclusive + singletonKey: no máximo 1 job por documento (fila ou ativo)', async () => {
    const id = randomUUID();
    const first = await boss.send(SUBMIT, { documentId: id }, { singletonKey: id });
    const second = await boss.send(SUBMIT, { documentId: id }, { singletonKey: id });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const [job] = await boss.fetch<{ documentId: string }>(SUBMIT, { batchSize: 1 });
    expect(job).toBeDefined();
    // Enquanto ativo, também não aceita outro job do mesmo documento.
    expect(await boss.send(SUBMIT, { documentId: id }, { singletonKey: id })).toBeNull();
    if (job) await boss.complete(SUBMIT, job.id);
  });

  it('workers concorrentes nunca recebem o mesmo job (SKIP LOCKED)', async () => {
    const ids = Array.from({ length: 20 }, () => randomUUID());
    for (const id of ids) await boss.send(SUBMIT, { documentId: id }, { singletonKey: id });
    const batches = await Promise.all(Array.from({ length: 8 }, () => boss.fetch<{ documentId: string }>(SUBMIT, { batchSize: 5 })));
    const fetched = batches.flat().map((j) => j.data.documentId).filter((d) => (ids as string[]).includes(d));
    expect(new Set(fetched).size).toBe(fetched.length);
    expect(fetched.length).toBe(20);
    for (const job of batches.flat()) await boss.complete(SUBMIT, job.id);
  });

  it('esgotadas as retentativas, o job vai para a DLQ', async () => {
    const id = randomUUID();
    await boss.send(SUBMIT, { documentId: id }, { singletonKey: id });
    for (let attempt = 0; attempt < 3; attempt++) {
      const jobs = await boss.fetch<{ documentId: string }>(SUBMIT, { batchSize: 10 });
      const job = jobs.find((j) => j.data.documentId === id);
      expect(job, `tentativa ${attempt + 1}`).toBeDefined();
      if (job) await boss.fail(SUBMIT, job.id, { reason: 'NOT_SENT' });
      for (const other of jobs.filter((j) => j.data.documentId !== id)) await boss.complete(SUBMIT, other.id);
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(await jobsFor(DLQ, id)).toBe(1);
  });
});
