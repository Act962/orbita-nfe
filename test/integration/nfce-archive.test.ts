import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { loadMunicipalities } from '../../src/main/fiscal-resources.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import { PI_QR_CODE_URL, qrCodeV3Online, SimulatedNfceAuthorizer, XmlNfcePreparer, type NfceArtifactStore } from '../../src/modules/nfce/public.js';
import { S3ArtifactStore, type ArchiveIntegrityAlertSink } from '../../src/modules/nfse/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import type { ClaimedJob } from '../../src/shared/application/job-queue.js';
import type { DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { FiscalSchemaCatalog } from '../../src/shared/infrastructure/xml/fiscal-schema-catalog.js';
import { MINIMAL_SALE } from '../support/nfce-fixtures.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, testCertificateKek, type ClientApp, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Arquivamento do nfeProc da NFC-e (ADR-0074, molde do ADR-0048): a autorização grava o SHA-256 e
 * enfileira `nfce.archive` na mesma transação; o job grava no bucket com Object Lock (SeaweedFS),
 * relê, confere e só então marca a nota. Venda e emitente FICTÍCIOS, autorizador SIMULADO.
 */
const API: AuditContext = { actor: { kind: 'CLIENT_APPLICATION', clientApplicationId: '00000000-0000-0000-0000-000000000000', credentialRef: 'credencial-teste' }, correlationId: null };
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
const CREDENTIALS = { accessKeyId: 'test-only', secretAccessKey: 'test-only' };
const RETENTION_DAYS = 1;
const storage = () => inject('objectStorage');

let t: TestApi;
let worker: DatabaseHandle;
let superuser: DatabaseHandle;
let pki: TestIcpPki;
let app: ClientApp;
let companyId: string;
let establishmentId: string;
let s3Store: S3ArtifactStore;
const gateway = new SimulatedNfceAuthorizer();
const catalog = FiscalSchemaCatalog.load(resolve(import.meta.dirname, '../../resources/fiscal/schemas'));
const preparer = new XmlNfcePreparer(
  catalog,
  { qrCode: ({ accessKey, environment }) => qrCodeV3Online({ baseUrl: PI_QR_CODE_URL, accessKey, environment }), consultationUrl: 'https://consulta.exemplo.invalid/nfce' },
  'orbita-nfe-teste',
);
const municipalities = loadMunicipalities();

const alerts: Parameters<ArchiveIntegrityAlertSink['raise']>[0][] = [];

function fiscalWorker(store: NfceArtifactStore = s3Store, options: { now?: () => Date; retentionDays?: number } = {}) {
  const composed = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
    nfce: { gateway, preparer, municipalities, archive: { store, retentionDays: options.retentionDays ?? RETENTION_DAYS, alerts: { raise: (alert) => alerts.push(alert) } } },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (composed.nfce?.archiver === undefined) throw new Error('nfce sem arquivamento');
  return composed;
}

let seq = 0;
async function authorizedInvoice(): Promise<string> {
  const idempotencyKey = `nfce-arquivo-${process.pid}-${++seq}`;
  const { invoice } = await t.modules.nfce.accept(
    { companyId, clientApplicationId: app.id, environment: 'HOMOLOGATION', establishmentId, idempotencyKey, requestHash: createHash('sha256').update(idempotencyKey).digest('hex'), sale: MINIMAL_SALE },
    API,
  );
  expect(await fiscalWorker().nfce?.processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
  return invoice.id;
}

async function row(id: string) {
  const rows = await superuser.db.execute<{
    nfe_proc_xml: string;
    nfe_proc_xml_sha256: string;
    nfe_proc_xml_object_key: string | null;
    nfe_proc_xml_archived_at: string | null;
    nfe_proc_xml_retain_until: string | null;
    authorized_at: string;
  }>(sql`select nfe_proc_xml, nfe_proc_xml_sha256, nfe_proc_xml_object_key, nfe_proc_xml_archived_at, nfe_proc_xml_retain_until, authorized_at from consumer_invoices where id = ${id}`);
  const found = rows.rows[0];
  if (found === undefined) throw new Error('nota não encontrada');
  return found;
}

const archiveJob = (invoiceId: string): ClaimedJob => ({ id: crypto.randomUUID(), queue: 'nfce.archive', payload: { companyId, invoiceId }, attempt: 1, correlationId: null });

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  superuser = connect('superuser', { poolMax: 1 });
  pki = createTestIcpPki();
  s3Store = new S3ArtifactStore({ endpoint: storage().endpoint, region: 'us-east-1', bucket: storage().artifactBucket, ...CREDENTIALS, forcePathStyle: true });
  app = await createClientApp(t.admin, 'nfce-arquivo');
  const key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  const cnpj = cnpjOf(company.root);
  establishmentId = await createEstablishment(t.app, key, companyId, cnpj);
  await t.app.inject({
    method: 'PUT',
    url: `/v1/establishments/${establishmentId}/state-profile`,
    headers: bearer(key, companyId),
    payload: { stateRegistration: '123456789', taxRegime: '1', address: { street: 'RUA TESTE', number: '100', district: 'CENTRO', postalCode: '64000000' } },
  });
  await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(key, companyId), payload: { kind: 'NFCE', environment: 'HOMOLOGATION', series: '1' } });
  const pfx = pki.pfx({ cnpj, password: 'senha-arquivo' });
  const upload = await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/certificates`, headers: bearer(key, companyId), payload: { pfx: pfx.toString('base64'), password: 'senha-arquivo' } });
  expect((await fiscalWorker().vault.validate(companyId, upload.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
});

afterAll(async () => {
  s3Store.close();
  await superuser.close();
  await worker.close();
  await t.close();
});

describe('arquivamento do nfeProc da NFC-e (ADR-0074)', () => {
  it('a autorização enfileira nfce.archive; o job grava no bucket com Object Lock, relê e marca a nota', async () => {
    const id = await authorizedInvoice();
    const before = await row(id);
    expect(before.nfe_proc_xml_sha256).toBe(createHash('sha256').update(before.nfe_proc_xml, 'utf8').digest('hex'));
    expect(before.nfe_proc_xml_object_key).toBeNull();
    const jobs = await superuser.db.execute<{ state: string; lane: string }>(sql`select state, lane from jobs where queue = 'nfce.archive' and payload->>'invoiceId' = ${id}`);
    expect(jobs.rows).toEqual([{ state: 'queued', lane: 'fiscal' }]);

    const handler = fiscalWorker().handlers['nfce.archive'];
    if (handler === undefined) throw new Error('sem handler');
    await handler(archiveJob(id), new AbortController().signal);

    const after = await row(id);
    const authorizedAt = new Date(before.authorized_at);
    const yyyy = String(authorizedAt.getUTCFullYear());
    const mm = String(authorizedAt.getUTCMonth() + 1).padStart(2, '0');
    expect(after.nfe_proc_xml_object_key).toBe(`company/${companyId}/nfce/${yyyy}/${mm}/${id}/nfce-${before.nfe_proc_xml_sha256}.xml`);
    expect(after.nfe_proc_xml_archived_at).not.toBeNull();
    expect(new Date(after.nfe_proc_xml_retain_until ?? 0).getTime()).toBe(authorizedAt.getTime() + RETENTION_DAYS * 86_400_000);

    // O objeto no bucket: os mesmos bytes, travado em COMPLIANCE.
    const s3 = new S3Client({ endpoint: storage().endpoint, region: 'us-east-1', forcePathStyle: true, credentials: CREDENTIALS });
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: storage().artifactBucket, Key: after.nfe_proc_xml_object_key ?? '' }));
      expect(await object.Body?.transformToString('utf8')).toBe(before.nfe_proc_xml);
      expect(object.ObjectLockMode).toBe('COMPLIANCE');
    } finally {
      s3.destroy();
    }

    const audit = await superuser.db.execute<{ action: string }>(sql`select action from audit_log where subject_id = ${id} and action = 'consumer_invoice.xml_archived'`);
    expect(audit.rows).toHaveLength(1);

    // Repetir é seguro: não envia de novo nem muda nada.
    expect(await fiscalWorker().nfce?.archiver?.archive(companyId, id, WORKER)).toEqual({ kind: 'ALREADY_ARCHIVED' });
    expect(await row(id)).toEqual(after);
  });

  it('releitura diferente do que foi gravado → erro e a nota NÃO fica arquivada', async () => {
    const id = await authorizedInvoice();
    const corrupting: NfceArtifactStore = { put: async (object) => Buffer.concat([await s3Store.put(object), Buffer.from(' ')]), read: (objectKey) => s3Store.read(objectKey) };
    await expect(fiscalWorker(corrupting).nfce?.archiver?.archive(companyId, id, WORKER)).rejects.toMatchObject({ code: 'NFCE_ARCHIVE_READBACK_MISMATCH' });
    expect((await row(id)).nfe_proc_xml_object_key).toBeNull();
    expect(await fiscalWorker().nfce?.archiver?.archive(companyId, id, WORKER)).toMatchObject({ kind: 'ARCHIVED' });
  });

  it('conferência diária (ADR-0075): o objeto íntegro vira conferência boa; o objeto sumido vira alerta e auditoria', async () => {
    // Retenção maior que os 30 dias da reconferência, para o objeto entrar na vez da conferência.
    const id = await authorizedInvoice();
    // 120 dias: o objeto continua dentro da retenção nas duas conferências simuladas (31 e 62 dias depois).
    await fiscalWorker(s3Store, { retentionDays: 120 }).nfce?.archiver?.archive(companyId, id, WORKER);
    const job = await superuser.db.execute<{ singleton_key: string }>(sql`select singleton_key from jobs where queue = 'nfse.verify-archives' and payload->>'companyId' = ${companyId}`);
    expect(job.rows.length).toBeGreaterThan(0);

    const later = new Date(Date.now() + 31 * 86_400_000);
    const verify = (store: NfceArtifactStore) => fiscalWorker(store, { now: () => later }).archiveVerifier?.verifyCompany(companyId, WORKER);
    expect(await verify(s3Store)).toMatchObject({ failed: 0 });
    const ok = await superuser.db.execute<{ failure_code: string | null; last_verified_at: string | null }>(
      sql`select failure_code, last_verified_at from archived_xml_checks where company_id = ${companyId} and kind = 'NFCE' and document_id = ${id}`,
    );
    expect(ok.rows).toHaveLength(1);
    expect(ok.rows[0]?.failure_code).toBeNull();
    expect(ok.rows[0]?.last_verified_at).not.toBeNull();

    // Dois dias depois, com o objeto "sumido" do bucket: alerta e auditoria no assunto da NFC-e.
    const missing: NfceArtifactStore = { put: (object) => s3Store.put(object), read: () => Promise.resolve(undefined) };
    const muchLater = new Date(later.getTime() + 31 * 86_400_000);
    const before = alerts.length;
    expect(await fiscalWorker(missing, { now: () => muchLater }).archiveVerifier?.verifyCompany(companyId, WORKER)).toMatchObject({ failed: 1 });
    expect(alerts.slice(before)).toEqual([{ companyId, kind: 'NFCE', documentId: id, invoiceId: id, failureCode: 'ARCHIVE_OBJECT_MISSING' }]);
    const audit = await superuser.db.execute<{ subject_type: string }>(
      sql`select subject_type from audit_log where subject_id = ${id} and action = 'consumer_invoice.archived_xml_check_failed'`,
    );
    expect(audit.rows).toEqual([{ subject_type: 'consumer_invoice' }]);
  });

  it('o banco recusa trocar a chave do objeto depois de gravada, mesmo para o superusuário', async () => {
    const id = await authorizedInvoice();
    await fiscalWorker().nfce?.archiver?.archive(companyId, id, WORKER);
    const changed = await superuser.db.execute(sql`update consumer_invoices set nfe_proc_xml_object_key = nfe_proc_xml_object_key || 'x' where id = ${id}`).then(
      () => 'aceitou',
      (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint,
    );
    expect(changed).toBe('ck_consumer_invoices_write_once');
  });
});
