import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import {
  S3ArtifactStore,
  SimulatedNfseGateway,
  XmlCancellationPreparer,
  XmlDpsPreparer,
  XmlNfseVerifier,
  type NfseArtifactStore,
} from '../../src/modules/nfse/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import type { ClaimedJob } from '../../src/shared/application/job-queue.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { FiscalSchemaCatalog } from '../../src/shared/infrastructure/xml/fiscal-schema-catalog.js';
import { sampleDpsData } from '../support/dps-fixtures.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, testCertificateKek, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Arquivamento do XML autorizado (ADR-0010, ADR-0048): a autorização grava o SHA-256 e enfileira
 * `nfse.archive` na mesma transação; o job grava no bucket com Object Lock (SeaweedFS), relê, confere
 * e só então marca a nota como arquivada. As colunas são gravadas uma vez.
 */
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
const ROOT = resolve(import.meta.dirname, '../../resources/fiscal/schemas');
const CREDENTIALS = { accessKeyId: 'test-only', secretAccessKey: 'test-only' };
const RETENTION_DAYS = 1;

let t: TestApi;
let worker: DatabaseHandle;
let superuser: DatabaseHandle;
let pki: TestIcpPki;
let catalog: FiscalSchemaCatalog;
let key: string;
let companyId: string;
let establishmentId: string;
let s3Store: S3ArtifactStore;
const gateway = new SimulatedNfseGateway();
const storage = () => inject('objectStorage');

function fiscalWorker(store: NfseArtifactStore = s3Store) {
  const composed = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
    nfse: {
      gateway,
      preparer: new XmlDpsPreparer(catalog, 'orbita-nfe-teste'),
      verifier: new XmlNfseVerifier(catalog),
      alerts: { raise: () => undefined },
      cancellationPreparer: new XmlCancellationPreparer(catalog, 'orbita-nfe-teste'),
      archive: { store, retentionDays: RETENTION_DAYS },
    },
  });
  if (composed.processor === undefined || composed.archiver === undefined) throw new Error('nfse não composto');
  return composed;
}

async function authorizedInvoice(idempotencyKey: string): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/service-invoices',
    headers: { ...bearer(key, companyId), 'idempotency-key': idempotencyKey },
    payload: { establishmentId, ...sampleDpsData() },
  });
  expect(res.statusCode, res.body).toBe(202);
  const id = res.json<{ id: string }>().id;
  expect(await fiscalWorker().processor?.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
  return id;
}

async function row(id: string) {
  const rows = await superuser.db.execute<{
    nfse_xml: string;
    nfse_xml_sha256: string | null;
    nfse_xml_object_key: string | null;
    nfse_xml_archived_at: Date | null;
    nfse_xml_retain_until: Date | null;
    authorized_at: Date;
  }>(sql`select nfse_xml, nfse_xml_sha256, nfse_xml_object_key, nfse_xml_archived_at, nfse_xml_retain_until, authorized_at from service_invoices where id = ${id}`);
  const found = rows.rows[0];
  if (found === undefined) throw new Error('nota não encontrada');
  // O execute cru devolve timestamptz como texto.
  const date = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));
  return {
    ...found,
    authorized_at: date(found.authorized_at) ?? new Date(0),
    nfse_xml_archived_at: date(found.nfse_xml_archived_at),
    nfse_xml_retain_until: date(found.nfse_xml_retain_until),
  };
}

const archiveJob = (invoiceId: string): ClaimedJob => ({ id: crypto.randomUUID(), queue: 'nfse.archive', payload: { companyId, invoiceId }, attempt: 1, correlationId: null });

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  superuser = connect('superuser', { poolMax: 1 });
  pki = createTestIcpPki();
  catalog = FiscalSchemaCatalog.load(ROOT);
  s3Store = new S3ArtifactStore({ endpoint: storage().endpoint, region: 'us-east-1', bucket: storage().artifactBucket, ...CREDENTIALS, forcePathStyle: true });
  const app = await createClientApp(t.admin, 'nfse-arquivo');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'nfse:issue', 'nfse:read']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(company.root));
  const series = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/document-series`,
    headers: bearer(key, companyId),
    payload: { kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' },
  });
  expect(series.statusCode).toBe(201);
  const pfx = pki.pfx({ cnpj: cnpjOf(company.root), password: 'senha-arquivo' });
  const upload = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/certificates`,
    headers: bearer(key, companyId),
    payload: { pfx: pfx.toString('base64'), password: 'senha-arquivo' },
  });
  expect((await fiscalWorker().vault.validate(companyId, upload.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
});

afterAll(async () => {
  s3Store.close();
  await superuser.close();
  await worker.close();
  await t.close();
});

describe('arquivamento do XML autorizado (ADR-0048)', () => {
  it('a autorização grava o SHA-256 e enfileira nfse.archive; o job grava no bucket com Object Lock, relê e marca a nota', async () => {
    const id = await authorizedInvoice('arquivo-1');
    const before = await row(id);
    expect(before.nfse_xml_sha256).toBe(createHash('sha256').update(before.nfse_xml, 'utf8').digest('hex'));
    expect(before.nfse_xml_object_key).toBeNull();
    const jobs = await superuser.db.execute<{ state: string; lane: string }>(
      sql`select state, lane from jobs where queue = 'nfse.archive' and payload->>'invoiceId' = ${id}`,
    );
    expect(jobs.rows).toEqual([{ state: 'queued', lane: 'fiscal' }]);

    const handler = fiscalWorker().handlers['nfse.archive'];
    if (handler === undefined) throw new Error('sem handler');
    await handler(archiveJob(id), new AbortController().signal);

    const after = await row(id);
    const yyyy = String(before.authorized_at.getUTCFullYear());
    const mm = String(before.authorized_at.getUTCMonth() + 1).padStart(2, '0');
    expect(after.nfse_xml_object_key).toBe(`company/${companyId}/nfse/${yyyy}/${mm}/${id}/nfse-${before.nfse_xml_sha256 ?? ''}.xml`);
    expect(after.nfse_xml_archived_at).not.toBeNull();
    expect(after.nfse_xml_retain_until?.getTime()).toBe(before.authorized_at.getTime() + RETENTION_DAYS * 86_400_000);

    // O objeto no bucket: os mesmos bytes, travado em COMPLIANCE.
    const s3 = new S3Client({ endpoint: storage().endpoint, region: 'us-east-1', forcePathStyle: true, credentials: CREDENTIALS });
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: storage().artifactBucket, Key: after.nfse_xml_object_key ?? '' }));
      expect(await object.Body?.transformToString('utf8')).toBe(before.nfse_xml);
      expect(object.ObjectLockMode).toBe('COMPLIANCE');
    } finally {
      s3.destroy();
    }

    const audit = await superuser.db.execute<{ action: string }>(
      sql`select action from audit_log where company_id = ${companyId} and subject_id = ${id} and action = 'service_invoice.xml_archived'`,
    );
    expect(audit.rows).toHaveLength(1);

    // Repetir é seguro: não envia de novo nem muda nada.
    expect(await fiscalWorker().archiver?.archive(companyId, id, WORKER)).toEqual({ kind: 'ALREADY_ARCHIVED' });
    expect(await row(id)).toEqual(after);
  });

  it('releitura diferente do que foi gravado → erro e a nota NÃO fica arquivada', async () => {
    const id = await authorizedInvoice('arquivo-2');
    const corrupting: NfseArtifactStore = { put: async (object) => Buffer.concat([await s3Store.put(object), Buffer.from(' ')]) };
    await expect(fiscalWorker(corrupting).archiver?.archive(companyId, id, WORKER)).rejects.toMatchObject({ code: 'NFSE_ARCHIVE_READBACK_MISMATCH' });
    expect((await row(id)).nfse_xml_object_key).toBeNull();
    // Com o bucket certo, a nova tentativa arquiva.
    expect(await fiscalWorker().archiver?.archive(companyId, id, WORKER)).toMatchObject({ kind: 'ARCHIVED' });
  });

  it('o banco recusa trocar o hash ou a chave depois de gravados, e carimbar hash em XML antigo', async () => {
    const id = await authorizedInvoice('arquivo-3');
    await fiscalWorker().archiver?.archive(companyId, id, WORKER);
    const tx = new CompanyTransactions(worker.db);
    const attempt = (statement: ReturnType<typeof sql>) =>
      tx.run(companyId, (t2) => t2.execute(statement)).then(
        () => 'ok',
        (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint ?? String(error),
      );
    expect(await attempt(sql`update service_invoices set nfse_xml_sha256 = ${'0'.repeat(64)} where id = ${id}`)).toBe('ck_service_invoices_write_once');
    expect(await attempt(sql`update service_invoices set nfse_xml_object_key = 'outra' where id = ${id}`)).toBe('ck_service_invoices_write_once');
    expect(await attempt(sql`update service_invoices set nfse_xml_retain_until = now() where id = ${id}`)).toBe('ck_service_invoices_write_once');
  });

  it('a API não grava o arquivamento (privilégio só do worker-fiscal)', async () => {
    const id = await authorizedInvoice('arquivo-4');
    // Transação crua (sem a tradução de erros do CompanyTransactions), como nos testes de privilégio.
    const update = t.api.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
      return tx.execute(sql`update service_invoices set nfse_xml_object_key = 'x' where id = ${id}`);
    });
    await expect(update).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
