import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { loadMunicipalities } from '../../src/main/fiscal-resources.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import { PI_QR_CODE_URL, qrCodeV3Online, SimulatedNfceAuthorizer, XmlNfcePreparer, type NfceAuthorizerGateway } from '../../src/modules/nfce/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { FiscalSchemaCatalog } from '../../src/shared/infrastructure/xml/fiscal-schema-catalog.js';
import { MINIMAL_SALE } from '../support/nfce-fixtures.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, testCertificateKek, type ClientApp, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Núcleo da emissão de NFC-e (ADR-0072, fatia 3) contra o PostgreSQL real, o preparador REAL (XML
 * montado, assinado com certificado ICP de teste e validado no XSD do PL_010h) e o SIMULADOR do
 * autorizador. Venda, emitente e certificado FICTÍCIOS; nada sai para órgão nenhum.
 */
const API: AuditContext = { actor: { kind: 'CLIENT_APPLICATION', clientApplicationId: '00000000-0000-0000-0000-000000000000', credentialRef: 'credencial-teste' }, correlationId: null };
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
const MIN = 60_000;

let t: TestApi;
let worker: DatabaseHandle;
let pki: TestIcpPki;
let app: ClientApp;
let key: string;
let companyId: string;
let establishmentId: string;
let gateway: SimulatedNfceAuthorizer;

let clock = new Date();
const now = (): Date => clock;
const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

const catalog = FiscalSchemaCatalog.load(resolve(import.meta.dirname, '../../resources/fiscal/schemas'));
const municipalities = loadMunicipalities();
const preparer = new XmlNfcePreparer(
  catalog,
  { qrCode: ({ accessKey, environment }) => qrCodeV3Online({ baseUrl: PI_QR_CODE_URL, accessKey, environment }), consultationUrl: 'https://consulta.exemplo.invalid/nfce' },
  'orbita-nfe-teste',
);

function buildWorker(g: NfceAuthorizerGateway = gateway) {
  const composed = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
    nfce: { gateway: g, preparer, municipalities },
    now,
  });
  if (composed.nfce === undefined) throw new Error('nfce não composto');
  return composed;
}

let keySeq = 0;
async function accept(): Promise<string> {
  const idempotencyKey = `nfce-emissao-${process.pid}-${++keySeq}`;
  const { invoice } = await t.modules.nfce.accept(
    { companyId, clientApplicationId: app.id, environment: 'HOMOLOGATION', establishmentId, idempotencyKey, requestHash: createHash('sha256').update(idempotencyKey).digest('hex'), sale: MINIMAL_SALE },
    API,
  );
  return invoice.id;
}

async function state(invoiceId: string) {
  // Papel da API: lê a nota e as tentativas, mas não o XML assinado (que este teste não precisa).
  return new CompanyTransactions(t.api.db).run(companyId, async (tx) => {
    const invoice = await tx.execute<{ status: string; access_key: string | null; authorizer_status_code: string | null; protocol_number: string | null; nfe_proc_xml: string | null; rejection_code: string | null; failure_code: string | null }>(
      sql`select status, access_key, authorizer_status_code, protocol_number, nfe_proc_xml, rejection_code, failure_code from consumer_invoices where id = ${invoiceId}`,
    );
    const attempts = await tx.execute<{ seq: number; state: string; outcome: string | null; access_key: string; payload_sha256: string; issued_at: string }>(
      sql`select seq, state, outcome, access_key, payload_sha256, issued_at from consumer_invoice_attempts where invoice_id = ${invoiceId} order by seq`,
    );
    return { ...invoice.rows[0], attempts: attempts.rows };
  });
}

/** Eventos `consumer_invoice.status_changed` da nota: só os campos que variam com o resultado. */
async function events(invoiceId: string): Promise<Record<string, unknown>[]> {
  const rows = await new CompanyTransactions(t.api.db).run(companyId, (tx) =>
    tx.execute<{ data: Record<string, unknown> }>(sql`select data from outbox_events where subject_id = ${invoiceId} and type = 'consumer_invoice.status_changed' order by occurred_at`),
  );
  const varying = ['status', 'accessKey', 'statusCode', 'rejectionCode', 'failureCode'];
  return rows.rows.map(({ data }) => Object.fromEntries(Object.entries(data).filter(([k]) => varying.includes(k))));
}

async function jobs(invoiceId: string, queue: string) {
  const rows = await t.adminDb.db.execute<{ singleton_key: string; run_at: Date }>(sql`select singleton_key, run_at from jobs where queue = ${queue} and payload->>'invoiceId' = ${invoiceId} order by created_at`);
  return rows.rows;
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker', { poolMax: 10 });
  pki = createTestIcpPki();
  app = await createClientApp(t.admin, 'nfce-emissao');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  const cnpj = cnpjOf(company.root);
  establishmentId = await createEstablishment(t.app, key, companyId, cnpj);
  const profile = await t.app.inject({
    method: 'PUT',
    url: `/v1/establishments/${establishmentId}/state-profile`,
    headers: bearer(key, companyId),
    payload: { stateRegistration: '123456789', taxRegime: '1', address: { street: 'RUA TESTE', number: '100', district: 'CENTRO', postalCode: '64000000' } },
  });
  expect(profile.statusCode, profile.body).toBe(200);
  const series = await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(key, companyId), payload: { kind: 'NFCE', environment: 'HOMOLOGATION', series: '1' } });
  expect(series.statusCode).toBe(201);
  const pfx = pki.pfx({ cnpj, password: 'senha-teste-nfce' });
  const cert = await t.app.inject({ method: 'POST', url: `/v1/establishments/${establishmentId}/certificates`, headers: bearer(key, companyId), payload: { pfx: pfx.toString('base64'), password: 'senha-teste-nfce' } });
  expect(cert.statusCode).toBe(202);
  gateway = new SimulatedNfceAuthorizer(now);
  expect((await buildWorker().vault.validate(companyId, cert.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
});

afterAll(async () => {
  await worker.close();
  await t.close();
});

beforeEach(() => {
  clock = new Date();
  gateway = new SimulatedNfceAuthorizer(now);
});

describe('envio da NFC-e (ADR-0072, ADR-0070)', () => {
  it('autorizada: XML real assinado e válido no XSD, nfeProc gravado, uma recepção só', async () => {
    const id = await accept();
    const { nfce } = buildWorker();
    expect(await nfce?.processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const s = await state(id);
    expect(s).toMatchObject({ status: 'AUTHORIZED', authorizer_status_code: '100', attempts: [{ seq: 1, state: 'CLOSED', outcome: 'AUTHORIZED' }] });
    expect(s.access_key).toBe(s.attempts[0]?.access_key);
    expect(s.access_key).toMatch(/^22\d{4}[0-9A-Z]{12}\d{2}65001\d{9}1\d{9}$/);
    expect(s.nfe_proc_xml).toContain('<nfeProc');
    expect(s.nfe_proc_xml).toContain(`<chNFe>${s.access_key ?? ''}</chNFe>`);
    expect(s.nfe_proc_xml).toContain('<xMun>Teresina</xMun>');
    expect(gateway.received.get(s.access_key ?? '')).toBe(1);

    // ADR-0073: o nfeProc gravado passa no procNFe_v4.00.xsd oficial e sai no download com o hash conferido.
    const proc = await catalog.validate('nfe/4.00-nfe-pl010h', 'procNFe_v4.00.xsd', s.nfe_proc_xml ?? '');
    expect(proc.errors).toEqual([]);
    const download = await t.modules.nfce.authorizedXml(companyId, app.id, 'HOMOLOGATION', id);
    expect(download).toMatchObject({ xml: s.nfe_proc_xml, fileName: `${s.access_key ?? ''}-procNFe.xml` });
    expect(download.sha256).toBe(createHash('sha256').update(s.nfe_proc_xml ?? '', 'utf8').digest('hex'));
    // Webhook consumer_invoice.status_changed na mesma transação, só com identificadores.
    expect(await events(id)).toEqual([{ status: 'AUTHORIZED', accessKey: s.access_key, statusCode: '100' }]);
  });

  it('rejeitada: REJECTED com o código, nada gravado no autorizador', async () => {
    gateway.onSubmit('REJECT').rejectWith('725', 'Rejeicao simulada de CFOP');
    const id = await accept();
    await buildWorker().nfce?.processor.process(companyId, id, WORKER);
    expect(await state(id)).toMatchObject({ status: 'REJECTED', rejection_code: '725', access_key: null });
    expect(await events(id)).toEqual([{ status: 'REJECTED', rejectionCode: '725' }]);
    await expect(t.modules.nfce.authorizedXml(companyId, app.id, 'HOMOLOGATION', id)).rejects.toMatchObject({ code: 'NFCE_XML_NOT_AVAILABLE' });
  });

  it('denegada: DENIED com a chave e o cStat (a nota foi gravada; número consumido)', async () => {
    gateway.onSubmit('DENY');
    const id = await accept();
    await buildWorker().nfce?.processor.process(companyId, id, WORKER);
    const s = await state(id);
    expect(s).toMatchObject({ status: 'DENIED', authorizer_status_code: '301', attempts: [{ outcome: 'DENIED' }] });
    expect(s.access_key).not.toBeNull();
  });

  it('NOT_SENT: volta a PENDING; a nova tentativa monta XML novo (dhEmi novo), mesma chave no mesmo mês', async () => {
    gateway.onSubmit('NOT_SENT');
    const id = await accept();
    const { nfce } = buildWorker();
    await nfce?.processor.process(companyId, id, WORKER);
    expect(await state(id)).toMatchObject({ status: 'PENDING', attempts: [{ outcome: 'NOT_SENT' }] });
    expect((await jobs(id, 'nfce.process')).map((j) => j.singleton_key)).toContain(`${id}:resend:1`);

    advance(MIN);
    await nfce?.processor.process(companyId, id, WORKER);
    const s = await state(id);
    expect(s.status).toBe('AUTHORIZED');
    expect(s.attempts.map((a) => a.outcome)).toEqual(['NOT_SENT', 'AUTHORIZED']);
    expect(s.attempts[0]?.payload_sha256).not.toBe(s.attempts[1]?.payload_sha256);
    expect(s.attempts[0]?.access_key).toBe(s.attempts[1]?.access_key);
    // SQL cru devolve o timestamp como texto.
    expect(Date.parse(String(s.attempts[1]?.issued_at))).toBeGreaterThan(Date.parse(String(s.attempts[0]?.issued_at)));
  });

  it('processa e derruba: UNKNOWN; a consulta pela chave e pelo digest acha a autorização, sem reenviar', async () => {
    gateway.onSubmit('PROCESS_THEN_DROP');
    const id = await accept();
    const { nfce } = buildWorker();
    await nfce?.processor.process(companyId, id, WORKER);
    expect(await state(id)).toMatchObject({ status: 'UNKNOWN', attempts: [{ outcome: 'UNKNOWN' }] });
    expect(await nfce?.reconciler.reconcile(companyId, id, WORKER)).toMatchObject({ kind: 'WAITING' });

    advance(3 * MIN);
    expect(await nfce?.reconciler.reconcile(companyId, id, WORKER)).toEqual({ kind: 'AUTHORIZED' });
    const s = await state(id);
    expect(s).toMatchObject({ status: 'AUTHORIZED', authorizer_status_code: '100' });
    expect((await events(id)).map((e) => e['status'])).toEqual(['UNKNOWN', 'AUTHORIZED']);
    expect(s.nfe_proc_xml).toContain('<protNFe');
    expect(gateway.submits).toBe(1);
  });

  it('nada chegou: duas respostas "não consta" espaçadas → PENDING e nova tentativa; a nota sai uma vez só', async () => {
    gateway.onSubmit('DROP_BEFORE_PROCESSING');
    const id = await accept();
    const { nfce } = buildWorker();
    await nfce?.processor.process(companyId, id, WORKER);
    advance(3 * MIN);
    expect(await nfce?.reconciler.reconcile(companyId, id, WORKER)).toMatchObject({ kind: 'CONSULT_AGAIN', lookup: 'NOT_FOUND' });
    advance(6 * MIN);
    expect(await nfce?.reconciler.reconcile(companyId, id, WORKER)).toEqual({ kind: 'NEW_ATTEMPT_SCHEDULED' });
    expect((await state(id)).status).toBe('PENDING');

    await nfce?.processor.process(companyId, id, WORKER);
    const s = await state(id);
    expect(s.status).toBe('AUTHORIZED');
    expect(s.attempts.map((a) => a.outcome)).toEqual(['UNKNOWN', 'AUTHORIZED']);
    expect(gateway.received.get(s.access_key ?? '')).toBe(1);
  });

  it('erro de consulta nunca leva a FAILED: backoff e nova consulta', async () => {
    gateway.onSubmit('PROCESS_THEN_DROP').onLookup('ERROR');
    const id = await accept();
    const { nfce } = buildWorker();
    await nfce?.processor.process(companyId, id, WORKER);
    advance(3 * MIN);
    expect(await nfce?.reconciler.reconcile(companyId, id, WORKER)).toMatchObject({ kind: 'CONSULT_AGAIN', lookup: 'ERROR' });
    expect((await state(id)).status).toBe('UNKNOWN');
  });

  it('queda com a tentativa em SENDING: a recuperação leva a UNKNOWN (nunca a PENDING)', async () => {
    const hanging: NfceAuthorizerGateway = { submit: () => new Promise(() => undefined), lookup: () => new Promise(() => undefined) };
    const id = await accept();
    void buildWorker(hanging).nfce?.processor.process(companyId, id, WORKER);
    await expect.poll(async () => (await state(id)).attempts[0]?.state, { timeout: 5000 }).toBe('SENDING');

    advance(3 * MIN); // concessão vencida
    expect(await buildWorker().nfce?.processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'UNKNOWN' });
    expect(await state(id)).toMatchObject({ status: 'UNKNOWN', attempts: [{ outcome: 'RECOVERED_UNKNOWN' }] });
  });

  it('falha local antes do envio (perfil estadual apagado): FAILED, nada transmitido', async () => {
    const id = await accept();
    await t.app.inject({ method: 'DELETE', url: `/v1/establishments/${establishmentId}/state-profile`, headers: bearer(key, companyId) });
    try {
      expect(await buildWorker().nfce?.processor.process(companyId, id, WORKER)).toEqual({ kind: 'FAILED', code: 'NFCE_STATE_PROFILE_REQUIRED' });
      expect(await state(id)).toMatchObject({ status: 'FAILED', failure_code: 'NFCE_STATE_PROFILE_REQUIRED', attempts: [] });
      expect(gateway.submits).toBe(0);
    } finally {
      await t.app.inject({
        method: 'PUT',
        url: `/v1/establishments/${establishmentId}/state-profile`,
        headers: bearer(key, companyId),
        payload: { stateRegistration: '123456789', taxRegime: '1', address: { street: 'RUA TESTE', number: '100', district: 'CENTRO', postalCode: '64000000' } },
      });
    }
  });
});
