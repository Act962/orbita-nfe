import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFiscalWorker, composeGeneralWorker } from '../../src/main/compose.js';
import { X509TrustStore, type CertificateVault } from '../../src/modules/certificates/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import {
  bearer,
  cnpjOf,
  createClientApp,
  createCompany,
  createEstablishment,
  startTestApi,
  testCertificateKek,
  testWebhookKey,
  type TestApi,
} from './support/api.js';
import { connect } from './support/db.js';

/**
 * Avisos de vencimento de certificado (doc 13 §4): agendados pelo worker-fiscal na ativação,
 * decididos pelo worker-general na hora, sem leitura entre empresas e sem aviso repetido.
 */
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
const DAY = 86_400_000;

let t: TestApi;
let worker: DatabaseHandle;
let general: DatabaseHandle;
let vault: CertificateVault;
let pki: TestIcpPki;
let key: string;
let companyId: string;
let root: string;
let establishmentId: string;
let clock = new Date();

async function activate(notAfter: Date): Promise<string> {
  const pfx = pki.pfx({ cnpj: cnpjOf(root), password: 'senha-teste-venc', notAfter });
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/certificates`,
    headers: bearer(key, companyId),
    payload: { pfx: pfx.toString('base64'), password: 'senha-teste-venc' },
  });
  expect(res.statusCode).toBe(202);
  const id = res.json<{ id: string }>().id;
  expect((await vault.validate(companyId, id, WORKER)).kind).toBe('ACTIVATED');
  return id;
}

const notifier = () =>
  composeGeneralWorker({ db: general.db, webhookSecretKeys: [testWebhookKey().privateKey], allowPrivateWebhookTargets: true, webhookTimeoutMs: 2000, now: () => clock });

async function events(certificateId: string) {
  const rows = await new CompanyTransactions(t.api.db).run(companyId, (tx) =>
    tx.execute<{ type: string; data: Record<string, unknown> }>(sql`select type, data from outbox_events where subject_id = ${certificateId} order by occurred_at`),
  );
  return rows.rows;
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  general = connect('general');
  pki = createTestIcpPki();
  vault = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
  }).vault;
  const app = await createClientApp(t.admin, 'venc');
  key = await app.key(['companies:create', 'companies:manage', 'certificates:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root));
});

afterAll(async () => {
  await worker.close();
  await general.close();
  await t.close();
});

describe('avisos de vencimento', () => {
  it('a ativação agenda um job por limiar na lane general, no mesmo commit', async () => {
    const notAfter = new Date(Date.now() + 200 * DAY);
    const id = await activate(notAfter);
    const jobs = await t.adminDb.db.execute<{ lane: string; run_at: Date; payload: Record<string, string> }>(
      sql`select lane, run_at, payload from jobs where queue = 'certificates.expiry-notice' and payload->>'certificateId' = ${id} order by run_at`,
    );
    // Certificado de teste: validade truncada em segundos no X.509.
    const daysBefore = jobs.rows.map((j) => Math.round((Math.floor(notAfter.getTime() / 1000) * 1000 - new Date(j.run_at).getTime()) / DAY));
    expect(daysBefore).toEqual([30, 15, 7, 1, 0]);
    expect(jobs.rows.every((j) => j.lane === 'general' && j.payload['companyId'] === companyId)).toBe(true);
  });

  it('decide o limiar na hora; não repete; vencido vira certificate.expired; fora da janela não avisa', async () => {
    const notAfter = new Date(Date.now() + 300 * DAY);
    const id = await activate(notAfter);
    const { expiry } = notifier();

    clock = new Date(notAfter.getTime() - 60 * DAY);
    expect(await expiry.notify(companyId, id, null)).toEqual({ kind: 'SKIPPED', reason: 'OUTSIDE_WINDOW' });

    clock = new Date(notAfter.getTime() - 10 * DAY);
    expect(await expiry.notify(companyId, id, null)).toEqual({ kind: 'NOTIFIED', type: 'certificate.expiring', thresholdDays: 15 });
    expect(await expiry.notify(companyId, id, null)).toEqual({ kind: 'SKIPPED', reason: 'ALREADY_NOTIFIED' });

    clock = new Date(notAfter.getTime() + DAY);
    expect(await expiry.notify(companyId, id, null)).toEqual({ kind: 'NOTIFIED', type: 'certificate.expired', thresholdDays: 0 });

    const published = await events(id);
    expect(published.map((e) => e.type)).toEqual(['certificate.activated', 'certificate.expiring', 'certificate.expired']);
    expect(published[1]?.data).toMatchObject({ certificateId: id, establishmentId, daysRemaining: 10, thresholdDays: 15 });
  });

  it('certificado revogado (ou substituído) não gera aviso', async () => {
    const id = await activate(new Date(Date.now() + 100 * DAY));
    const revoked = await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/certificates/${id}/revocation`, headers: bearer(key, companyId) });
    expect(revoked.statusCode).toBe(200);
    clock = new Date(Date.now() + 95 * DAY);
    expect(await notifier().expiry.notify(companyId, id, null)).toEqual({ kind: 'SKIPPED', reason: 'NOT_ACTIVE' });
  });

  it('o worker-general registra avisos mas não altera nem apaga; empresa errada não enxerga', async () => {
    const tx = new CompanyTransactions(general.db);
    await expect(tx.run(companyId, (q) => q.execute(sql`update certificate_expiry_notices set threshold_days = 1`))).rejects.toMatchObject({
      code: 'DATABASE_ACCESS_VIOLATION',
    });
    await expect(tx.run(companyId, (q) => q.execute(sql`delete from certificate_expiry_notices`))).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
    const other = await tx.run(crypto.randomUUID(), (q) => q.execute(sql`select count(*)::int as n from certificate_expiry_notices`));
    expect(other.rows[0]).toEqual({ n: 0 });
  });
});
