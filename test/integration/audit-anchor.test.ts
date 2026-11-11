import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { composeAuditVerifier, composeGeneralWorker } from '../../src/main/compose.js';
import { DrizzleAuditChainReader, S3AnchorStore, sha256ChainHasher, type AuditChainRef } from '../../src/modules/audit/public.js';
import { entryPayload, GENESIS_HASH_HEX } from '../../src/modules/audit/domain/audit-entry.js';
import type { ClaimedJob, QueueName } from '../../src/shared/application/job-queue.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, testWebhookKey, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Âncora externa da auditoria (ADR-0031): cabeça de cada cadeia gravada num bucket com Object
 * Lock; quem reescreve o banco inteiro e recalcula os hashes é pego pela âncora.
 */
const CREDENTIALS = { accessKeyId: 'test-only', secretAccessKey: 'test-only' };

let t: TestApi;
let general: DatabaseHandle;
let superuser: DatabaseHandle;
let store: S3AnchorStore;
let key: string;
let companyId: string;
let root: string;
const clock = { now: new Date() };

const storage = () => inject('objectStorage');

function worker() {
  return composeGeneralWorker({
    db: general.db,
    webhookSecretKeys: [testWebhookKey().privateKey],
    allowPrivateWebhookTargets: true,
    webhookTimeoutMs: 2000,
    anchorStore: store,
    now: () => clock.now,
  });
}

/** Roda o handler de um job como o JobRunner faria. */
async function runJob(queue: QueueName, payload: Record<string, string>): Promise<void> {
  const handler = worker().handlers[queue];
  if (handler === undefined) throw new Error(`sem handler: ${queue}`);
  const job: ClaimedJob = { id: crypto.randomUUID(), queue, payload, attempt: 1, correlationId: null };
  await handler(job, new AbortController().signal);
}

async function anchorJobs(singletonPrefix: string) {
  const rows = await t.adminDb.db.execute<{ lane: string; run_at: Date; singleton_key: string; state: string }>(
    sql`select lane, run_at, singleton_key, state from jobs where queue like 'audit.anchor-%' and singleton_key like ${`${singletonPrefix}%`} order by run_at`,
  );
  return rows.rows;
}

beforeAll(async () => {
  t = await startTestApi();
  general = connect('general');
  superuser = connect('superuser', { poolMax: 1 });
  store = new S3AnchorStore({
    endpoint: storage().endpoint,
    region: 'us-east-1',
    bucket: storage().anchorBucket,
    ...CREDENTIALS,
    forcePathStyle: true,
    retentionDays: 1,
  });
  const app = await createClientApp(t.admin, 'ancora');
  key = await app.key(['companies:create', 'companies:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
});

afterAll(async () => {
  store.close();
  await general.close();
  await superuser.close();
  await t.close();
});

describe('âncora da cadeia da empresa', () => {
  it('o cadastro da empresa agenda a primeira âncora; a execução grava e agenda a do dia seguinte', async () => {
    const first = await anchorJobs(companyId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ lane: 'general', state: 'queued' });

    // A empresa ganha mais registros (estabelecimento) antes da âncora.
    await createEstablishment(t.app, key, companyId, cnpjOf(root));

    clock.now = new Date('2026-11-11T10:00:00Z');
    await runJob('audit.anchor-company', { companyId });

    const latest = await store.latest({ kind: 'COMPANY', companyId });
    const verifier = composeAuditVerifier({ db: t.adminDb.db });
    const verification = await verifier.verify({ kind: 'COMPANY', companyId });
    expect(verification.ok).toBe(true);
    expect(latest).toMatchObject({ sequence: verification.ok ? verification.head?.sequence : -1, hashHex: verification.ok ? verification.head?.hashHex : '' });
    expect(latest?.retainUntil).not.toBeNull();

    const next = (await anchorJobs(companyId)).filter((j) => j.singleton_key === `${companyId}:2026-11-12`);
    expect(next).toHaveLength(1);
    expect(new Date(next[0]?.run_at ?? 0).toISOString()).toBe('2026-11-12T06:00:00.000Z');

    // Repetir o job (ex.: concessão vencida) não duplica o agendamento do dia seguinte.
    await runJob('audit.anchor-company', { companyId });
    expect((await anchorJobs(companyId)).filter((j) => j.singleton_key === `${companyId}:2026-11-12`)).toHaveLength(1);
  });

  it('reescrita completa da cadeia com hashes recalculados: a verificação interna passa, a âncora pega', async () => {
    const chain: AuditChainRef = { kind: 'COMPANY', companyId };
    const anchor = await store.latest(chain);
    if (anchor === undefined) throw new Error('sem âncora');

    // Atacante com superusuário: desliga os triggers, altera o 1º registro e recalcula tudo.
    const reader = new DrizzleAuditChainReader(superuser.db, (id, work) => new CompanyTransactions(superuser.db).run(id, work));
    const entries = await reader.page(chain, 0, 1000);
    await superuser.db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger user`);
      let previous = GENESIS_HASH_HEX;
      for (const entry of entries) {
        const forged = entry.sequence === 1 ? { ...entry, details: { ...entry.details, legalName: 'EMPRESA ADULTERADA' } } : entry;
        const hash = sha256ChainHasher.link(previous, entryPayload(forged));
        await tx.execute(sql`update audit_log set details = ${JSON.stringify(forged.details)}::jsonb, prev_hash = decode(${previous}, 'hex'), hash = decode(${hash}, 'hex')
                             where company_id = ${companyId} and sequence = ${entry.sequence}`);
        previous = hash;
      }
      await tx.execute(sql`update audit_chain_heads set last_hash = decode(${previous}, 'hex') where company_id = ${companyId}`);
      await tx.execute(sql`alter table audit_log enable trigger user`);
    });

    const verifier = composeAuditVerifier({ db: t.adminDb.db });
    expect((await verifier.verify(chain)).ok).toBe(true);
    expect(await verifier.verify(chain, anchor)).toEqual({ ok: false, sequence: anchor.sequence, reason: 'ANCHOR_MISMATCH' });
  });

  it('âncora além do fim da cadeia (registros apagados) → ANCHOR_MISMATCH', async () => {
    const verifier = composeAuditVerifier({ db: t.adminDb.db });
    const fake = { sequence: 10_000, hashHex: 'ab'.repeat(32) };
    expect(await verifier.verify({ kind: 'COMPANY', companyId }, fake)).toMatchObject({ ok: false, reason: 'ANCHOR_MISMATCH' });
  });

  it('o bucket não deixa apagar a âncora (Object Lock COMPLIANCE)', async () => {
    const latest = await store.latest({ kind: 'COMPANY', companyId });
    const s3 = new S3Client({ endpoint: storage().endpoint, region: 'us-east-1', forcePathStyle: true, credentials: CREDENTIALS });
    try {
      const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: storage().anchorBucket, Prefix: latest?.location ?? 'x' }));
      const versionId = listed.Versions?.[0]?.VersionId;
      expect(versionId).toBeDefined();
      await expect(s3.send(new DeleteObjectCommand({ Bucket: storage().anchorBucket, Key: latest?.location ?? 'x', VersionId: versionId }))).rejects.toThrow();
    } finally {
      s3.destroy();
    }
  });
});

describe('âncora da plataforma e privilégios', () => {
  it('a inicialização garante a âncora diária da plataforma uma vez só; a execução grava', async () => {
    clock.now = new Date('2026-11-11T07:00:00Z');
    await worker().ensureRecurringJobs();
    await worker().ensureRecurringJobs();
    expect(await anchorJobs('platform:2026-11-12')).toHaveLength(1);

    // A cadeia da plataforma tem registros (aplicações e credenciais criadas pelos testes).
    await runJob('audit.anchor-platform', {});
    const latest = await store.latest({ kind: 'PLATFORM' });
    const verification = await composeAuditVerifier({ db: t.adminDb.db }).verify({ kind: 'PLATFORM' }, latest);
    expect(verification.ok).toBe(true);
  });

  it('o worker-general só lê a cabeça pela função, e só com empresa no contexto', async () => {
    await expect(general.db.execute(sql`select * from audit_company_head_for_anchor()`)).rejects.toThrow();
    await expect(new CompanyTransactions(general.db).run(companyId, (tx) => tx.execute(sql`select count(*) from audit_log`))).rejects.toMatchObject({
      code: 'DATABASE_ACCESS_VIOLATION',
    });
    await expect(general.db.execute(sql`select * from audit_chain_heads`)).rejects.toThrow();
  });
});
