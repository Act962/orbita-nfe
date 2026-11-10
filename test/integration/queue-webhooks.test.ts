import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeAuditVerifier, composeFiscalWorker, composeGeneralWorker, composeQueueAdmin } from '../../src/main/compose.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import type { JobLane } from '../../src/shared/application/job-queue.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { createLogger } from '../../src/shared/infrastructure/logging/logger.js';
import { JobRunner } from '../../src/shared/infrastructure/queue/job-runner.js';
import { PostgresJobStore, transactionalJobScheduler } from '../../src/shared/infrastructure/queue/postgres-queue.js';
import type { QueueAdmin } from '../../src/shared/infrastructure/queue/queue-admin.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import {
  OPERATOR,
  bearer,
  cnpjOf,
  createClientApp,
  createCompany,
  createEstablishment,
  problemCode,
  startTestApi,
  testCertificateKek,
  testWebhookKey,
  type TestApi,
} from './support/api.js';
import { connect, newId } from './support/db.js';

/**
 * Semana 6: fila própria (ADR-0030), outbox, validação de certificado pela fila e webhooks
 * assinados (ADR-0015, ADR-0027 B6), rate limit (ADR-0026) e operação das filas.
 *
 * Os workers deste arquivo consomem a fila inteira; por isso o projeto de integração roda os
 * arquivos em sequência (vitest.config.ts).
 */
interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly path: string;
}

let t: TestApi;
let worker: DatabaseHandle;
let general: DatabaseHandle;
let superuser: DatabaseHandle;
let admin: QueueAdmin;
let pki: TestIcpPki;
let fiscalRunner: JobRunner;
let generalRunner: JobRunner;
let closeGeneral: () => Promise<void>;
let server: Server;
let baseUrl: string;
const received: Received[] = [];
let responseStatus = 200;

let key: string;
let companyId: string;
let root: string;
let establishmentId: string;

const silent = createLogger({ level: 'silent', service: 'test' });
const OPS: AuditContext & { actor: { kind: 'OPERATOR'; operator: string } } = { actor: { kind: 'OPERATOR', operator: 'teste-automatizado' }, correlationId: null };

/** Verificação independente da assinatura (o que o cliente faria). */
function verifySignature(secret: string, r: Received): boolean {
  const keyBytes = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', keyBytes).update(`${String(r.headers['webhook-id'])}.${String(r.headers['webhook-timestamp'])}.${r.body}`).digest('base64');
  return String(r.headers['webhook-signature']) === `v1,${expected}`;
}

const drainAll = async (): Promise<void> => {
  // fiscal pode gerar trabalho para general (outbox) e vice-versa não; duas voltas bastam.
  for (let i = 0; i < 2; i++) {
    await fiscalRunner.drain();
    await generalRunner.drain();
  }
};

const subscribe = async (eventTypes: string[], path = '/hook', token = key, company = companyId) => {
  const res = await t.app.inject({ method: 'POST', url: '/v1/webhook-subscriptions', headers: bearer(token, company), payload: { url: `${baseUrl}${path}`, eventTypes } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string; secret: string }>();
};

const delivery = async (id: string, token = key, company = companyId) =>
  (await t.app.inject({ method: 'GET', url: `/v1/webhook-deliveries/${id}`, headers: bearer(token, company) })).json<Record<string, unknown>>();

const uploadCertificate = async (cnpjRoot = root, establishment = establishmentId, token = key, company = companyId): Promise<string> => {
  const pfx = pki.pfx({ cnpj: cnpjOf(cnpjRoot), password: 'senha-teste' });
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishment}/certificates`,
    headers: bearer(token, company),
    payload: { pfx: pfx.toString('base64'), password: 'senha-teste' },
  });
  expect(res.statusCode, res.body).toBe(202);
  return res.json<{ id: string }>().id;
};

/** Antecipa jobs agendados para o futuro (simula a passagem do tempo). Superusuário: ignora RLS. */
const fastForward = (lane: JobLane) => superuser.db.execute(sql`update jobs set run_at = now() where lane = ${lane} and state = 'queued'`);

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  general = connect('general');
  superuser = connect('superuser', { poolMax: 2 });
  admin = composeQueueAdmin({ db: t.adminDb.db });
  pki = createTestIcpPki();

  const fiscal = composeFiscalWorker({ db: worker.db, certificateKeks: [testCertificateKek().privateKey], trustStore: X509TrustStore.fromPem(pki.trustBundlePem) });
  fiscalRunner = new JobRunner(new PostgresJobStore(worker.db), { lane: 'fiscal', handlers: fiscal.handlers, workerId: 'teste-fiscal', logger: silent, concurrency: 4, pollIntervalMs: 50 });
  const gen = composeGeneralWorker({ db: general.db, webhookSecretKeys: [testWebhookKey().privateKey], allowPrivateWebhookTargets: true, webhookTimeoutMs: 3000 });
  closeGeneral = gen.close;
  generalRunner = new JobRunner(new PostgresJobStore(general.db), { lane: 'general', handlers: gen.handlers, workerId: 'teste-general', logger: silent, concurrency: 4, pollIntervalMs: 50 });

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), path: req.url ?? '' });
      res.statusCode = responseStatus;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Esvazia o que outros arquivos deixaram na fila antes de começar.
  await drainAll();

  const app = await createClientApp(t.admin, 'semana6');
  key = await app.key(['companies:create', 'companies:manage', 'certificates:manage', 'webhooks:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root));
});

afterAll(async () => {
  await closeGeneral();
  await new Promise((resolve) => server.close(resolve));
  await t.close();
  await worker.close();
  await general.close();
  await superuser.close();
});

describe('fila própria (ADR-0030)', () => {
  const count = async (db: DatabaseHandle, id: string): Promise<number> =>
    Number((await db.db.execute<{ n: string }>(sql`select count(*) as n from jobs where payload->>'certificateId' = ${id}`)).rows[0]?.n ?? 0);

  it('o job nasce na mesma transação: rollback não deixa job, commit deixa', async () => {
    const rolledBack = newId();
    await expect(
      worker.db.transaction(async (tx) => {
        await transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId: rolledBack } });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const committed = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId: committed } }));
    expect(await count(t.adminDb, rolledBack)).toBe(0);
    expect(await count(t.adminDb, committed)).toBe(1);
    await admin.discard((await admin.listDead(500)).at(0)?.id ?? newId(), 'limpeza', OPERATOR).catch(() => undefined);
  });

  it('cada worker só enxerga a própria lane; a API não lê a fila', async () => {
    const certificateId = newId();
    await t.api.db.transaction((tx) => transactionalJobScheduler(tx, newId).enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId } }));
    expect(await count(worker, certificateId)).toBe(1);
    expect(await count(general, certificateId)).toBe(0);
    await expect(t.api.db.execute(sql`select count(*) from jobs`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a API não absorve chave singleton repetida: repetição é erro de programação', async () => {
    const singletonKey = newId();
    const enqueue = () =>
      t.api.db.transaction((tx) =>
        transactionalJobScheduler(tx, newId).enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId: newId() }, singletonKey }),
      );
    await enqueue();
    await expect(enqueue()).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('workers concorrentes nunca recebem o mesmo job (SKIP LOCKED)', async () => {
    const store = new PostgresJobStore(worker.db);
    const ids = Array.from({ length: 20 }, () => newId());
    await worker.db.transaction(async (tx) => {
      const scheduler = transactionalJobScheduler(tx, newId, 'fiscal');
      for (const id of ids) await scheduler.enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId: id } });
    });
    const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => store.claim('fiscal', ['certificates.validate'], 10, `w${i}`)));
    const claimed = batches.flatMap((b, i) => b.map((job) => ({ job, worker: `w${i}` })));
    const ours = claimed.map((c) => c.job.payload['certificateId']).filter((id) => id !== undefined && ids.includes(id));
    expect(new Set(ours).size).toBe(ours.length);
    expect(ours).toHaveLength(20);
    for (const c of claimed) await store.complete(c.job.id, c.worker);
  });

  it('falha volta à fila com backoff; esgotada vai para mortos; permanente vai direto', async () => {
    const store = new PostgresJobStore(worker.db);
    const certificateId = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId } }));
    const states: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = (await store.claim('fiscal', ['certificates.validate'], 50, 'w')).find((j) => j.payload['certificateId'] === certificateId);
      expect(job?.attempt).toBe(attempt);
      if (job === undefined) return;
      states.push(await store.fail(job.id, 'w', { code: 'NOT_SENT', permanent: false, retryInSeconds: 0 }));
    }
    expect(states).toEqual(['queued', 'queued', 'queued', 'queued', 'dead']);
    const dead = (await admin.listDead(500)).find((j) => j.lastError === 'NOT_SENT');
    expect(dead).toBeDefined();

    const permanentId = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId: permanentId } }));
    const job = (await store.claim('fiscal', ['certificates.validate'], 50, 'w')).find((j) => j.payload['certificateId'] === permanentId);
    expect(await store.fail(job?.id ?? '', 'w', { code: 'JOB_PAYLOAD_INVALID', permanent: true, retryInSeconds: 0 })).toBe('dead');
  });

  it('concessão vencida (worker morreu) devolve o job à fila', async () => {
    const store = new PostgresJobStore(worker.db);
    const certificateId = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId } }));
    const job = (await store.claim('fiscal', ['certificates.validate'], 50, 'morto')).find((j) => j.payload['certificateId'] === certificateId);
    await superuser.db.execute(sql`update jobs set lease_until = now() - interval '1 second' where id = ${job?.id ?? ''}`);
    expect(await store.reapExpired('fiscal', 0)).toBeGreaterThanOrEqual(1);
    const row = (await t.adminDb.db.execute<{ state: string; last_error: string }>(sql`select state, last_error from jobs where id = ${job?.id ?? ''}`)).rows[0];
    expect(row).toEqual({ state: 'queued', last_error: 'LEASE_EXPIRED' });
    // O job antigo do "worker morto" não pode mais ser concluído por ele.
    await store.complete(job?.id ?? '', 'morto');
    expect((await t.adminDb.db.execute<{ state: string }>(sql`select state from jobs where id = ${job?.id ?? ''}`)).rows[0]?.state).toBe('queued');
  });

  it('o banco impede mover job de lane ou trocar o conteúdo', async () => {
    const certificateId = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId } }));
    await expect(worker.db.execute(sql`update jobs set lane = 'general' where payload->>'certificateId' = ${certificateId}`)).rejects.toMatchObject({ cause: { code: expect.stringMatching(/42501|23514/) as unknown } });
    // Coluna sem grant de UPDATE para o worker; e o trigger barra até quem ignora o RLS e os grants.
    await expect(worker.db.execute(sql`update jobs set payload = '{}'::jsonb where payload->>'certificateId' = ${certificateId}`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(superuser.db.execute(sql`update jobs set payload = '{}'::jsonb where payload->>'certificateId' = ${certificateId}`)).rejects.toMatchObject({ cause: { constraint: 'ck_jobs_immutable' } });
  });

  it('operador pausa e retoma a fila, reprocessa e descarta, tudo na trilha da plataforma', async () => {
    await fiscalRunner.drain();
    await admin.setPaused('certificates.validate', true, 'manutenção programada', OPS);
    const certificateId = newId();
    await worker.db.transaction((tx) => transactionalJobScheduler(tx, newId, 'fiscal').enqueue({ queue: 'certificates.validate', payload: { companyId, certificateId } }));
    const store = new PostgresJobStore(worker.db);
    expect(await store.claim('fiscal', ['certificates.validate'], 50, 'w')).toEqual([]);
    expect((await admin.overview()).find((q) => q.queue === 'certificates.validate')).toMatchObject({ paused: true });
    await admin.setPaused('certificates.validate', false, null, OPS);
    const claimed = await store.claim('fiscal', ['certificates.validate'], 50, 'w');
    expect(claimed.some((j) => j.payload['certificateId'] === certificateId)).toBe(true);
    for (const j of claimed) await store.fail(j.id, 'w', { code: 'TESTE', permanent: true, retryInSeconds: 0 });

    const dead = (await admin.listDead(500)).find((j) => j.lastError === 'TESTE');
    expect(dead).toBeDefined();
    if (dead === undefined) return;
    await admin.retry(dead.id, OPS);
    await expect(admin.retry(dead.id, OPS)).rejects.toMatchObject({ code: 'JOB_NOT_DEAD' });
    await admin.discard(dead.id, 'job de teste sem destino', OPS);
    await expect(admin.setPaused('certificates.validate', true, '', OPS)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(admin.setPaused('fila.inexistente', true, 'motivo qualquer', OPS)).rejects.toMatchObject({ code: 'QUEUE_NOT_FOUND' });

    const result = await composeAuditVerifier({ db: t.adminDb.db }).verify({ kind: 'PLATFORM' });
    expect(result.ok).toBe(true);
  });
});

describe('certificado validado pela fila (semana 6)', () => {
  it('upload → job no mesmo commit → worker-fiscal valida → evento no outbox', async () => {
    const certificateId = await uploadCertificate();
    const job = (
      await t.adminDb.db.execute<{ queue: string; lane: string; payload: Record<string, string> }>(
        sql`select queue, lane, payload from jobs where payload->>'certificateId' = ${certificateId}`,
      )
    ).rows[0];
    expect(job).toEqual({ queue: 'certificates.validate', lane: 'fiscal', payload: { companyId, certificateId } });

    await fiscalRunner.drain();
    const res = await t.app.inject({ method: 'GET', url: `/v1/establishments/${establishmentId}/certificates/${certificateId}`, headers: bearer(key, companyId) });
    expect(res.json<{ status: string }>().status).toBe('ACTIVE');

    const events = await new CompanyTransactions(t.api.db).run(companyId, (tx) =>
      tx.execute<{ type: string; data: Record<string, unknown> }>(sql`select type, data from outbox_events where subject_id = ${certificateId}`),
    );
    expect(events.rows).toEqual([{ type: 'certificate.activated', data: expect.objectContaining({ certificateId, establishmentId, status: 'ACTIVE' }) as unknown }]);
  });
});

describe('webhooks (ADR-0015, ADR-0027 B6)', () => {
  it('o segredo aparece só na criação; a API não consegue ler o segredo cifrado', async () => {
    const created = await subscribe(['certificate.activated']);
    expect(created.secret).toMatch(/^whsec_/);
    const get = await t.app.inject({ method: 'GET', url: `/v1/webhook-subscriptions/${created.id}`, headers: bearer(key, companyId) });
    expect(get.body).not.toContain(created.secret);
    expect(get.body).not.toContain('secret"');
    await expect(
      new CompanyTransactions(t.api.db).run(companyId, (tx) => tx.execute(sql`select secret_ciphertext from webhook_subscriptions where id = ${created.id}`)),
    ).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
    expect(t.logs.text()).not.toContain(created.secret);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${created.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('evento do certificado chega assinado ao destino, com o mesmo id do evento', async () => {
    const sub = await subscribe(['certificate.activated', 'certificate.rejected'], '/e2e');
    const before = received.length;
    const certificateId = await uploadCertificate();
    await drainAll();
    const got = received.slice(before).filter((r) => r.path === '/e2e');
    expect(got).toHaveLength(1);
    const [request] = got;
    if (request === undefined) return;
    expect(verifySignature(sub.secret, request)).toBe(true);
    const body = JSON.parse(request.body) as { id: string; type: string; companyId: string; data: Record<string, unknown> };
    expect(body).toMatchObject({ type: 'certificate.activated', companyId, data: { certificateId, status: 'ACTIVE' } });
    expect(request.headers['webhook-id']).toBe(body.id);
    expect(request.headers['content-type']).toBe('application/json');
    const deliveries = await t.app.inject({ method: 'GET', url: `/v1/webhook-deliveries?subscriptionId=${sub.id}`, headers: bearer(key, companyId) });
    expect(deliveries.json<{ items: unknown[] }>().items).toEqual([expect.objectContaining({ status: 'SUCCEEDED', attempts: 1, eventId: body.id, lastHttpStatus: 200 })]);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('filtro por tipo: só recebe o que assinou', async () => {
    const onlyRevoked = await subscribe(['certificate.revoked'], '/so-revogacao');
    const before = received.length;
    const certificateId = await uploadCertificate();
    await drainAll();
    expect(received.slice(before).filter((r) => r.path === '/so-revogacao')).toHaveLength(0);
    await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/certificates/${certificateId}/revocation`, headers: bearer(key, companyId) });
    await drainAll();
    const got = received.slice(before).filter((r) => r.path === '/so-revogacao');
    expect(got.map((r) => (JSON.parse(r.body) as { type: string }).type)).toEqual(['certificate.revoked']);
    expect(verifySignature(onlyRevoked.secret, got[0] as Received)).toBe(true);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${onlyRevoked.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('falha → nova tentativa no calendário publicado → sucesso, com o mesmo webhook-id', async () => {
    const sub = await subscribe(['certificate.activated'], '/instavel');
    const test = await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/test`, headers: bearer(key, companyId) });
    expect(test.statusCode).toBe(202);
    const deliveryId = test.json<{ id: string }>().id;

    responseStatus = 500;
    await generalRunner.drain();
    const failed = await delivery(deliveryId);
    expect(failed).toMatchObject({ status: 'RETRYING', attempts: 1, lastHttpStatus: 500, lastErrorCode: 'HTTP_STATUS' });
    const wait = (Date.parse(String(failed['nextAttemptAt'])) - Date.parse(String(failed['lastAttemptAt']))) / 1000;
    expect(wait).toBeGreaterThanOrEqual(55);
    expect(wait).toBeLessThanOrEqual(65);

    responseStatus = 200;
    await generalRunner.drain();
    expect((await delivery(deliveryId))['status']).toBe('RETRYING');
    await fastForward('general');
    await generalRunner.drain();
    expect(await delivery(deliveryId)).toMatchObject({ status: 'SUCCEEDED', attempts: 2, lastHttpStatus: 200 });
    const got = received.filter((r) => r.path === '/instavel');
    expect(got).toHaveLength(2);
    expect(new Set(got.map((r) => r.headers['webhook-id'])).size).toBe(1);
    expect(got.every((r) => verifySignature(sub.secret, r))).toBe(true);

    const redelivery = await t.app.inject({ method: 'POST', url: `/v1/webhook-deliveries/${deliveryId}/redeliver`, headers: bearer(key, companyId) });
    expect(redelivery.statusCode).toBe(202);
    expect(redelivery.json()).toMatchObject({ redeliveryOf: deliveryId, status: 'PENDING', attempts: 0 });
    await generalRunner.drain();
    const again = received.filter((r) => r.path === '/instavel');
    expect(again).toHaveLength(3);
    expect(again[2]?.headers['webhook-id']).toBe(got[0]?.headers['webhook-id']);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('tentativas esgotadas → FAILED, sem novo agendamento', async () => {
    const sub = await subscribe(['certificate.activated'], '/sempre-falha');
    const deliveryId = (await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/test`, headers: bearer(key, companyId) })).json<{ id: string }>().id;
    await new CompanyTransactions(superuser.db).run(companyId, (tx) => tx.execute(sql`update webhook_deliveries set attempts = 7 where id = ${deliveryId}`));
    responseStatus = 503;
    await generalRunner.drain();
    responseStatus = 200;
    expect(await delivery(deliveryId)).toMatchObject({ status: 'FAILED', attempts: 8, nextAttemptAt: null, lastHttpStatus: 503 });
    const pending = await t.adminDb.db.execute(sql`select 1 from jobs where payload->>'deliveryId' = ${deliveryId} and state = 'queued'`);
    expect(pending.rows).toHaveLength(0);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('rotação do segredo: a entrega seguinte usa o novo segredo', async () => {
    const sub = await subscribe(['certificate.activated'], '/rotacao');
    const rotated = await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/secret-rotation`, headers: bearer(key, companyId) });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const { secret, secretVersion } = rotated.json<{ secret: string; secretVersion: number }>();
    expect(secretVersion).toBe(2);
    expect(secret).not.toBe(sub.secret);
    await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/test`, headers: bearer(key, companyId) });
    await generalRunner.drain();
    const request = received.filter((r) => r.path === '/rotacao').at(-1);
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(verifySignature(secret, request)).toBe(true);
    expect(verifySignature(sub.secret, request)).toBe(false);
    expect(JSON.parse(request.body)).toMatchObject({ type: 'webhook.test', data: { subscriptionId: sub.id } });
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('assinatura desativada não aceita teste nem reenvio', async () => {
    const sub = await subscribe(['certificate.activated'], '/desativada');
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
    const res = await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/test`, headers: bearer(key, companyId) });
    expect(res.statusCode).toBe(422);
    expect(problemCode(res)).toBe('WEBHOOK_SUBSCRIPTION_DISABLED');
  });

  it('outra aplicação com acesso à MESMA empresa não vê nem altera as assinaturas', async () => {
    const sub = await subscribe(['certificate.activated'], '/da-orbita');
    const other = await createClientApp(t.admin, 'nerp');
    await t.admin.grantCompany(other.id, companyId);
    const otherKey = await other.key(['webhooks:manage']);
    const get = await t.app.inject({ method: 'GET', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(otherKey, companyId) });
    expect(get.statusCode).toBe(404);
    const list = await t.app.inject({ method: 'GET', url: '/v1/webhook-subscriptions', headers: bearer(otherKey, companyId) });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    const patch = await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(otherKey, companyId), payload: { status: 'DISABLED' } });
    expect(patch.statusCode).toBe(404);
    await t.app.inject({ method: 'PATCH', url: `/v1/webhook-subscriptions/${sub.id}`, headers: bearer(key, companyId), payload: { status: 'DISABLED' } });
  });

  it('concessão revogada: entrega pendente falha sem chamar o destino', async () => {
    const app = await createClientApp(t.admin, 'revogada');
    const appKey = await app.key(['companies:create', 'webhooks:manage']);
    const company = await createCompany(t.app, appKey);
    const sub = await subscribe(['certificate.activated'], '/revogada', appKey, company.id);
    const deliveryId = (await t.app.inject({ method: 'POST', url: `/v1/webhook-subscriptions/${sub.id}/test`, headers: bearer(appKey, company.id) })).json<{ id: string }>().id;
    await t.admin.revokeCompanyGrant(app.id, company.id);
    await generalRunner.drain();
    expect(received.filter((r) => r.path === '/revogada')).toHaveLength(0);
    const row = await new CompanyTransactions(superuser.db).run(company.id, (tx) =>
      tx.execute<{ status: string; last_error_code: string }>(sql`select status, last_error_code from webhook_deliveries where id = ${deliveryId}`),
    );
    expect(row.rows[0]).toEqual({ status: 'FAILED', last_error_code: 'COMPANY_ACCESS_REVOKED' });
  });

  it('validação de entrada: URL, tipos de evento e catálogo', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/v1/webhook-subscriptions',
      headers: bearer(key, companyId),
      payload: { url: 'ftp://x', eventTypes: ['webhook.test', 'nao.existe', 'certificate.activated', 'certificate.activated'] },
    });
    expect(bad.statusCode).toBe(400);
    const fields = bad.json<{ issues: { field: string; code: string }[] }>().issues.map((i) => `${i.field}:${i.code}`);
    expect(fields).toEqual(expect.arrayContaining(['body.url:URL_NOT_HTTPS', 'body.eventTypes:DUPLICATED', 'body.eventTypes.0:UNKNOWN_EVENT_TYPE', 'body.eventTypes.1:UNKNOWN_EVENT_TYPE']));
    const catalog = await t.app.inject({ method: 'GET', url: '/v1/webhook-event-types', headers: bearer(key) });
    expect(catalog.json<{ items: { type: string; subscribable: boolean }[]; retryScheduleSeconds: number[] }>()).toMatchObject({
      items: expect.arrayContaining([{ type: 'certificate.activated', subscribable: true, description: expect.any(String) as unknown }]) as unknown,
      retryScheduleSeconds: [60, 300, 900, 3600, 10_800, 21_600, 43_200],
    });
  });

  it('outbox é append-only, inclusive para o dono das tabelas', async () => {
    // Superusuário ignora o RLS, então o trigger vê as linhas (o dono, com FORCE RLS e sem
    // política, nem enxergaria as linhas).
    for (const statement of [sql`update outbox_events set type = 'x'`, sql`delete from outbox_events`, sql`truncate outbox_events cascade`]) {
      await expect(superuser.db.execute(statement)).rejects.toMatchObject({ cause: { constraint: 'ck_outbox_append_only' } });
    }
  });

  it('o worker-fiscal não lê assinaturas de webhook (segredos só no worker-general)', async () => {
    await expect(
      new CompanyTransactions(worker.db).run(companyId, (tx) => tx.execute(sql`select secret_ciphertext from webhook_subscriptions`)),
    ).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });
});

describe('rate limit (ADR-0026)', () => {
  it('por credencial: 429 com Retry-After e RateLimit-*', async () => {
    const limited = await startTestApi({ rateLimit: { perCredential: { capacity: 2, refillPerSecond: 0.01 }, perAddress: { capacity: 1000, refillPerSecond: 1000 } } });
    try {
      const app = await createClientApp(limited.admin, 'limite');
      const token = await app.key(['webhooks:read']);
      const call = () => limited.app.inject({ method: 'GET', url: '/v1/webhook-event-types', headers: bearer(token) });
      const first = await call();
      expect(first.statusCode).toBe(200);
      expect(first.headers['ratelimit-limit']).toBe('2');
      expect(first.headers['ratelimit-remaining']).toBe('1');
      await call();
      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(problemCode(third)).toBe('RATE_LIMITED');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      // Outra credencial não é afetada.
      const otherToken = await app.key(['webhooks:read']);
      expect((await limited.app.inject({ method: 'GET', url: '/v1/webhook-event-types', headers: bearer(otherToken) })).statusCode).toBe(200);
      // Saúde não tem limite.
      expect((await limited.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('por endereço, antes da autenticação (freia força bruta de credenciais)', async () => {
    const limited = await startTestApi({ rateLimit: { perCredential: { capacity: 1000, refillPerSecond: 1000 }, perAddress: { capacity: 3, refillPerSecond: 0.01 } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await limited.app.inject({ method: 'GET', url: '/v1/webhook-event-types', headers: { authorization: 'Bearer fk_test_x_y' } })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});
