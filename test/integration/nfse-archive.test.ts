import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  type ArchiveIntegrityAlertSink,
  type NfseArtifactStore,
} from '../../src/modules/nfse/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import type { ClaimedJob } from '../../src/shared/application/job-queue.js';
import { nextDailyRun, runDay } from '../../src/shared/domain/daily-schedule.js';
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
const alerts: Parameters<ArchiveIntegrityAlertSink['raise']>[0][] = [];
const storage = () => inject('objectStorage');

function fiscalWorker(store: NfseArtifactStore = s3Store, options: { now?: () => Date; retentionDays?: number } = {}) {
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
      archive: { store, retentionDays: options.retentionDays ?? RETENTION_DAYS, alerts: { raise: (alert) => alerts.push(alert) } },
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (composed.processor === undefined || composed.archiver === undefined || composed.cancellations === undefined) throw new Error('nfse não composto');
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
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'nfse:issue', 'nfse:read', 'nfse:cancel']);
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
    const corrupting: NfseArtifactStore = { put: async (object) => Buffer.concat([await s3Store.put(object), Buffer.from(' ')]), read: (objectKey) => s3Store.read(objectKey) };
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

  it('evento de cancelamento (ADR-0049): o REGISTERED grava o hash e enfileira nfse.archive-cancellation; o XML vai para a pasta da nota', async () => {
    const id = await authorizedInvoice('arquivo-cancelamento');
    const requested = await t.app.inject({
      method: 'POST',
      url: `/v1/service-invoices/${id}/cancellation`,
      headers: bearer(key, companyId),
      payload: { reasonCode: '1', reasonText: 'Erro na emissão: valor digitado errado' },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const cancellationId = requested.json<{ id: string }>().id;
    expect(await fiscalWorker().cancellations?.process(companyId, cancellationId, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REGISTERED' });

    const event = async () => {
      const rows = await superuser.db.execute<{ event_xml: string; event_xml_sha256: string | null; event_xml_object_key: string | null; registered_at: string }>(
        sql`select event_xml, event_xml_sha256, event_xml_object_key, registered_at from service_invoice_cancellations where id = ${cancellationId}`,
      );
      const found = rows.rows[0];
      if (found === undefined) throw new Error('cancelamento não encontrado');
      return found;
    };
    const before = await event();
    expect(before.event_xml_sha256).toBe(createHash('sha256').update(before.event_xml, 'utf8').digest('hex'));
    const jobs = await superuser.db.execute<{ state: string }>(
      sql`select state from jobs where queue = 'nfse.archive-cancellation' and payload->>'cancellationId' = ${cancellationId}`,
    );
    expect(jobs.rows).toEqual([{ state: 'queued' }]);

    const handler = fiscalWorker().handlers['nfse.archive-cancellation'];
    if (handler === undefined) throw new Error('sem handler');
    await handler({ id: crypto.randomUUID(), queue: 'nfse.archive-cancellation', payload: { companyId, cancellationId }, attempt: 1, correlationId: null }, new AbortController().signal);

    const after = await event();
    const registeredAt = new Date(before.registered_at);
    const mm = String(registeredAt.getUTCMonth() + 1).padStart(2, '0');
    expect(after.event_xml_object_key).toBe(
      `company/${companyId}/nfse/${String(registeredAt.getUTCFullYear())}/${mm}/${id}/event-101101-${cancellationId}-${before.event_xml_sha256 ?? ''}.xml`,
    );
    const s3 = new S3Client({ endpoint: storage().endpoint, region: 'us-east-1', forcePathStyle: true, credentials: CREDENTIALS });
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: storage().artifactBucket, Key: after.event_xml_object_key ?? '' }));
      expect(await object.Body?.transformToString('utf8')).toBe(before.event_xml);
      expect(object.ObjectLockMode).toBe('COMPLIANCE');
    } finally {
      s3.destroy();
    }
    expect(await fiscalWorker().archiver?.archiveCancellationEvent(companyId, cancellationId, WORKER)).toEqual({ kind: 'ALREADY_ARCHIVED' });

    // Gravado uma vez, como o da nota.
    const update = new CompanyTransactions(worker.db)
      .run(companyId, (tx) => tx.execute(sql`update service_invoice_cancellations set event_xml_object_key = 'outra' where id = ${cancellationId}`))
      .then(
        () => 'ok',
        (error: unknown) => (error as { cause?: { constraint?: string } }).cause?.constraint ?? String(error),
      );
    expect(await update).toBe('ck_service_invoice_cancellations_write_once');
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

describe('download do XML pela API (ADR-0050)', () => {
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(key, companyId) });
  const sha = (xml: string) => createHash('sha256').update(xml, 'utf8').digest('hex');

  it('a nota autorizada devolve os bytes do banco, com ETag, Repr-Digest e sem cache', async () => {
    const id = await authorizedInvoice('download-1');
    const stored = await row(id);
    const res = await get(`/v1/service-invoices/${id}/xml`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe(stored.nfse_xml);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.headers['etag']).toBe(`"${sha(stored.nfse_xml)}"`);
    expect(res.headers['repr-digest']).toBe(`sha-256=:${createHash('sha256').update(stored.nfse_xml, 'utf8').digest('base64')}:`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const invoice = await get(`/v1/service-invoices/${id}`);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="nfse-${invoice.json<{ accessKey: string }>().accessKey}.xml"`);
  });

  it('nota ainda não autorizada: 404 NFSE_XML_NOT_AVAILABLE; outra aplicação: 404 SERVICE_INVOICE_NOT_FOUND', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/service-invoices',
      headers: { ...bearer(key, companyId), 'idempotency-key': 'download-pendente' },
      payload: { establishmentId, ...sampleDpsData() },
    });
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json<{ id: string }>().id;
    const pending = await get(`/v1/service-invoices/${id}/xml`);
    expect(pending.statusCode).toBe(404);
    expect(pending.json<{ code: string }>().code).toBe('NFSE_XML_NOT_AVAILABLE');

    const other = await createClientApp(t.admin, 'nfse-download-outra');
    const otherKey = await other.key(['nfse:read']);
    await t.admin.grantCompany(other.id, companyId);
    const authorized = await authorizedInvoice('download-outra-app');
    const denied = await t.app.inject({ method: 'GET', url: `/v1/service-invoices/${authorized}/xml`, headers: bearer(otherKey, companyId) });
    expect(denied.statusCode).toBe(404);
    expect(denied.json<{ code: string }>().code).toBe('SERVICE_INVOICE_NOT_FOUND');
  });

  it('cancelamento: só o evento REGISTERED tem XML; a nota cancelada continua com o XML autorizado', async () => {
    const id = await authorizedInvoice('download-cancelamento');
    const none = await get(`/v1/service-invoices/${id}/cancellation/xml`);
    expect(none.statusCode).toBe(404);
    expect(none.json<{ code: string }>().code).toBe('CANCELLATION_NOT_FOUND');

    const requested = await t.app.inject({
      method: 'POST',
      url: `/v1/service-invoices/${id}/cancellation`,
      headers: bearer(key, companyId),
      payload: { reasonCode: '2', reasonText: 'Serviço não prestado ao tomador' },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const cancellationId = requested.json<{ id: string }>().id;
    const pending = await get(`/v1/service-invoices/${id}/cancellation/xml`);
    expect(pending.statusCode).toBe(404);
    expect(pending.json<{ code: string }>().code).toBe('CANCELLATION_XML_NOT_AVAILABLE');

    expect(await fiscalWorker().cancellations?.process(companyId, cancellationId, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REGISTERED' });
    const rows = await superuser.db.execute<{ event_xml: string }>(sql`select event_xml from service_invoice_cancellations where id = ${cancellationId}`);
    const eventXml = rows.rows[0]?.event_xml ?? '';
    const res = await get(`/v1/service-invoices/${id}/cancellation/xml`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe(eventXml);
    expect(res.headers['etag']).toBe(`"${sha(eventXml)}"`);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="cancelamento-[0-9]+\.xml"$/);

    const invoice = await get(`/v1/service-invoices/${id}`);
    expect(invoice.json<{ status: string }>().status).toBe('CANCELLED');
    expect((await get(`/v1/service-invoices/${id}/xml`)).statusCode).toBe(200);
  });

  it('XML alterado por fora das travas: 500 sem os bytes (o hash não bate)', async () => {
    const id = await authorizedInvoice('download-adulterado');
    // Simula uma alteração que passou por fora dos triggers (ex.: restauração de cópia corrompida).
    await superuser.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`update service_invoices set nfse_xml = nfse_xml || ' ' where id = ${id}`);
    });
    const res = await get(`/v1/service-invoices/${id}/xml`);
    expect(res.statusCode).toBe(500);
    expect(res.json<{ code: string }>().code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('<NFSe');
  });
});

describe('conferência periódica dos XML arquivados (ADR-0051)', () => {
  const LONG_RETENTION = 40;
  const DAY = 86_400_000;
  const verifyJob = (): ClaimedJob => ({ id: crypto.randomUUID(), queue: 'nfse.verify-archives', payload: { companyId }, attempt: 1, correlationId: null });
  const verifyAt = async (at: Date) => {
    const handler = fiscalWorker(s3Store, { now: () => at }).handlers['nfse.verify-archives'];
    if (handler === undefined) throw new Error('sem handler');
    await handler(verifyJob(), new AbortController().signal);
  };
  const archived = async (idempotencyKey: string) => {
    const id = await authorizedInvoice(idempotencyKey);
    expect(await fiscalWorker(s3Store, { retentionDays: LONG_RETENTION }).archiver?.archive(companyId, id, WORKER)).toMatchObject({ kind: 'ARCHIVED' });
    return id;
  };
  const check = async (kind: string, documentId: string) => {
    const rows = await superuser.db.execute<{ last_verified_at: string | null; last_failed_at: string | null; failure_code: string | null }>(
      sql`select last_verified_at, last_failed_at, failure_code from archived_xml_checks where company_id = ${companyId} and kind = ${kind} and document_id = ${documentId}`,
    );
    return rows.rows[0];
  };
  /** Alteração por fora das travas (como uma restauração de cópia corrompida). */
  const bypass = (statement: ReturnType<typeof sql>) =>
    superuser.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(statement);
    });

  it('o arquivamento agenda a conferência; depois de 30 dias, nota e evento batem e a próxima fica agendada', async () => {
    const id = await archived('conferencia-ok');
    const seeded = await superuser.db.execute<{ state: string }>(
      sql`select state from jobs where queue = 'nfse.verify-archives' and payload->>'companyId' = ${companyId} and state = 'queued'`,
    );
    expect(seeded.rows.length).toBeGreaterThan(0);

    const requested = await t.app.inject({
      method: 'POST',
      url: `/v1/service-invoices/${id}/cancellation`,
      headers: bearer(key, companyId),
      payload: { reasonCode: '1', reasonText: 'Erro na emissão: tomador errado' },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const cancellationId = requested.json<{ id: string }>().id;
    expect(await fiscalWorker().cancellations?.process(companyId, cancellationId, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REGISTERED' });
    expect(await fiscalWorker(s3Store, { retentionDays: LONG_RETENTION }).archiver?.archiveCancellationEvent(companyId, cancellationId, WORKER)).toMatchObject({
      kind: 'ARCHIVED',
    });

    // Recém-arquivado: a releitura do arquivamento conta como conferência; nada na vez hoje.
    expect(await fiscalWorker().archiveVerifier?.verifyCompany(companyId, WORKER)).toEqual({ checked: 0, failed: 0, more: false });

    const later = new Date(Date.now() + 31 * DAY);
    const before = alerts.length;
    await verifyAt(later);
    expect(alerts.length).toBe(before);
    for (const [kind, documentId] of [['NFSE', id], ['CANCELLATION_EVENT', cancellationId]] as const) {
      const verified = await check(kind, documentId);
      expect(verified?.last_verified_at).not.toBeNull();
      expect([verified?.last_failed_at, verified?.failure_code]).toEqual([null, null]);
    }

    const next = await superuser.db.execute<{ run_at: string }>(
      sql`select run_at from jobs where queue = 'nfse.verify-archives' and singleton_key = ${`${companyId}:${runDay(nextDailyRun(later))}`} and state = 'queued'`,
    );
    expect(next.rows).toHaveLength(1);
    expect(new Date(next.rows[0]?.run_at ?? 0).getTime()).toBe(nextDailyRun(later).getTime());

    // Conferido agora: não volta na vez no mesmo dia.
    expect(await fiscalWorker(s3Store, { now: () => later }).archiveVerifier?.verifyCompany(companyId, WORKER)).toMatchObject({ checked: 0 });
  });

  it('XML do banco alterado, objeto ausente, bytes trocados e objeto sem trava: alerta, auditoria e nova conferência no dia seguinte', async () => {
    const dbTampered = await archived('conferencia-banco');
    const missing = await archived('conferencia-ausente');
    const forged = await archived('conferencia-trocado');
    const unlocked = await archived('conferencia-sem-trava');
    const s3 = new S3Client({ endpoint: storage().endpoint, region: 'us-east-1', forcePathStyle: true, credentials: CREDENTIALS });
    const putRaw = async (objectKey: string, body: string) => {
      await s3.send(
        new PutObjectCommand({ Bucket: storage().artifactBucket, Key: objectKey, Body: body, ContentMD5: createHash('md5').update(body, 'utf8').digest('base64') }),
      );
    };
    try {
      await bypass(sql`update service_invoices set nfse_xml = nfse_xml || ' ' where id = ${dbTampered}`);
      await bypass(sql`update service_invoices set nfse_xml_object_key = 'company/' || company_id || '/ausente/' || nfse_xml_sha256 || '.xml' where id = ${missing}`);
      const forgedRow = await row(forged);
      const forgedKey = `company/${companyId}/trocado/${forgedRow.nfse_xml_sha256 ?? ''}.xml`;
      await putRaw(forgedKey, `${forgedRow.nfse_xml}<!-- outro -->`);
      await bypass(sql`update service_invoices set nfse_xml_object_key = ${forgedKey} where id = ${forged}`);
      const unlockedRow = await row(unlocked);
      const unlockedKey = `company/${companyId}/sem-trava/${unlockedRow.nfse_xml_sha256 ?? ''}.xml`;
      await putRaw(unlockedKey, unlockedRow.nfse_xml);
      await bypass(sql`update service_invoices set nfse_xml_object_key = ${unlockedKey} where id = ${unlocked}`);
    } finally {
      s3.destroy();
    }

    const later = new Date(Date.now() + 31 * DAY);
    alerts.length = 0;
    await verifyAt(later);
    const expected = {
      [dbTampered]: 'DB_XML_HASH_MISMATCH',
      [missing]: 'ARCHIVE_OBJECT_MISSING',
      [forged]: 'ARCHIVE_OBJECT_HASH_MISMATCH',
      [unlocked]: 'ARCHIVE_OBJECT_NOT_LOCKED',
    };
    for (const [invoiceId, failureCode] of Object.entries(expected)) {
      const failed = await check('NFSE', invoiceId);
      expect(failed?.last_failed_at).not.toBeNull();
      expect([failed?.last_verified_at, failed?.failure_code]).toEqual([null, failureCode]);
      expect(alerts).toContainEqual({ companyId, kind: 'NFSE', documentId: invoiceId, invoiceId, failureCode });
    }
    expect(alerts).toHaveLength(4);
    const audit = await superuser.db.execute<{ subject_id: string; details: { failureCode: string } }>(
      sql`select subject_id, details from audit_log where company_id = ${companyId} and action = 'service_invoice.archived_xml_check_failed'`,
    );
    expect(Object.fromEntries(audit.rows.map((r) => [r.subject_id, r.details.failureCode]))).toEqual(expected);
    // Nada do conteúdo do XML no alerta nem na auditoria.
    expect(JSON.stringify(audit.rows)).not.toContain('<NFSe');

    // No mesmo dia, a falha não é conferida (nem alertada) de novo; no dia seguinte, sim.
    await verifyAt(new Date(later.getTime() + 60_000));
    expect(alerts).toHaveLength(4);
    await verifyAt(new Date(later.getTime() + DAY + 60_000));
    expect(alerts).toHaveLength(8);
  });
});