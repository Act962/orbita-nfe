import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import { SimulatedNfseGateway, XmlDpsPreparer, XmlNfseVerifier } from '../../src/modules/nfse/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { FiscalSchemaCatalog } from '../../src/shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, verifyEnveloped } from '../../src/shared/infrastructure/xml/xml-signer.js';
import { sampleDpsData } from '../support/dps-fixtures.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, problemCode, startTestApi, testCertificateKek, type TestApi } from './support/api.js';
import { connect } from './support/db.js';

/**
 * Emissão de ponta a ponta pela API (ADR-0033): HTTP → aceite → worker-fiscal com o preparador
 * REAL (XML do contrato v1, assinatura, XSD oficial da produção restrita) → SIMULADOR do
 * autorizador → consulta por HTTP. Nada sai para órgão nenhum.
 */
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
const ROOT = resolve(import.meta.dirname, '../../resources/fiscal/schemas');

let t: TestApi;
let worker: DatabaseHandle;
let pki: TestIcpPki;
let catalog: FiscalSchemaCatalog;
let key: string;
let otherAppKey: string;
let companyId: string;
let root: string;
let establishmentId: string;
const gateway = new SimulatedNfseGateway();

const post = (body: Record<string, unknown>, idempotencyKey: string | undefined, token = key) =>
  t.app.inject({
    method: 'POST',
    url: '/v1/service-invoices',
    headers: { ...bearer(token, companyId), ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }) },
    payload: body,
  });

const get = (id: string, token = key) => t.app.inject({ method: 'GET', url: `/v1/service-invoices/${id}`, headers: bearer(token, companyId) });

function fiscalWorker() {
  const composed = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
    nfse: { gateway, preparer: new XmlDpsPreparer(catalog, 'orbita-nfe-teste'), verifier: new XmlNfseVerifier(catalog), alerts: { raise: () => undefined } },
  });
  if (composed.processor === undefined) throw new Error('nfse não composto');
  return { vault: composed.vault, processor: composed.processor };
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  pki = createTestIcpPki();
  catalog = FiscalSchemaCatalog.load(ROOT);
  const app = await createClientApp(t.admin, 'nfse-api');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'nfse:issue', 'nfse:read']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root));

  const other = await createClientApp(t.admin, 'nfse-api-outra');
  otherAppKey = await other.key(['nfse:issue', 'nfse:read']);
  await t.admin.grantCompany(other.id, companyId);

  const series = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/document-series`,
    headers: bearer(key, companyId),
    payload: { kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' },
  });
  expect(series.statusCode).toBe(201);
  const pfx = pki.pfx({ cnpj: cnpjOf(root), password: 'senha-nfse-api' });
  const upload = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/certificates`,
    headers: bearer(key, companyId),
    payload: { pfx: pfx.toString('base64'), password: 'senha-nfse-api' },
  });
  expect((await fiscalWorker().vault.validate(companyId, upload.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
});

afterAll(async () => {
  await worker.close();
  await t.close();
});

describe('POST /v1/service-invoices → worker → GET', () => {
  it('emite em homologação: 202 PENDING, worker monta/assina/valida, simulador autoriza, GET mostra AUTHORIZED', async () => {
    const res = await post({ establishmentId, externalReference: 'pedido-e2e-1', ...sampleDpsData() }, 'e2e-1');
    expect(res.statusCode, res.body).toBe(202);
    const accepted = res.json<{ id: string; status: string; environment: string; dpsId: string; number: number }>();
    expect(accepted).toMatchObject({ status: 'PENDING', environment: 'HOMOLOGATION' });
    expect(res.headers['location']).toBe(`/v1/service-invoices/${accepted.id}`);

    expect(await fiscalWorker().processor.process(companyId, accepted.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });

    const after = await get(accepted.id);
    expect(after.statusCode).toBe(200);
    expect(after.json<{ status: string; accessKey: string | null }>()).toMatchObject({ status: 'AUTHORIZED', accessKey: expect.stringMatching(/^SIM/) as unknown });
    expect(gateway.received.get(accepted.dpsId)).toBe(1);

    // O XML transmitido: leiaute da produção restrita, válido no XSD oficial e com assinatura que confere.
    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_dps: string; layout_package: string }>(sql`select signed_dps, layout_package from service_invoices where id = ${accepted.id}`),
    );
    const row = stored.rows[0];
    if (row === undefined) throw new Error('nota não encontrada');
    expect(row.layout_package).toBe('nfse-nacional/1.01-20261020-prodrest');
    expect(row.signed_dps).toContain(`<infDPS Id="${accepted.dpsId}"><tpAmb>2</tpAmb>`);
    expect((await catalog.validate(row.layout_package, 'DPS_v1.01.xsd', row.signed_dps)).errors).toEqual([]);
    const cert = await t.app.inject({ method: 'GET', url: `/v1/establishments/${establishmentId}/certificates`, headers: bearer(key, companyId) });
    expect(cert.statusCode).toBe(200);
    expect(row.signed_dps).toContain('<X509Certificate>');
    const embedded = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(row.signed_dps)?.[1] ?? '';
    const pem = `-----BEGIN CERTIFICATE-----\n${embedded.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
    expect(verifyEnveloped(row.signed_dps, pem, SIGNATURE_PROFILES.nfseNacionalDps)).toEqual({ valid: true });
  }, 60_000);

  it('repetição idempotente: 200 com a mesma nota; mesma chave com outro corpo → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const body = { establishmentId, ...sampleDpsData() };
    const first = await post(body, 'e2e-2');
    const again = await post(body, 'e2e-2');
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const changed = await post({ ...body, competenceDate: '2026-11-10' }, 'e2e-2');
    expect(changed.statusCode).toBe(422);
    expect(problemCode(changed)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('sem Idempotency-Key → 400; enumeração fora do XSD → 400 com o campo', async () => {
    expect((await post({ establishmentId, ...sampleDpsData() }, undefined)).statusCode).toBe(400);
    const bad = await post({ establishmentId, ...sampleDpsData({ provider: { simplesNacionalOption: '7', specialTaxRegime: '0' } }) }, 'e2e-3');
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('provider.simplesNacionalOption');
  });

  it('formato certo, mas fora do XSD (30/02) → 400 VALIDATION_FAILED com DPS_SCHEMA_INVALID, antes de numerar', async () => {
    const res = await post({ establishmentId, ...sampleDpsData({ competenceDate: '2026-02-30' }) }, 'e2e-4');
    expect(res.statusCode).toBe(400);
    expect(problemCode(res)).toBe('VALIDATION_FAILED');
    expect(res.json<{ issues: { code: string }[] }>().issues[0]?.code).toBe('DPS_SCHEMA_INVALID');
  });

  it('referência externa em andamento → 409 DOCUMENT_IN_PROGRESS', async () => {
    expect((await post({ establishmentId, externalReference: 'pedido-e2e-5', ...sampleDpsData() }, 'e2e-5a')).statusCode).toBe(202);
    const dup = await post({ establishmentId, externalReference: 'pedido-e2e-5', ...sampleDpsData() }, 'e2e-5b');
    expect(dup.statusCode).toBe(409);
    expect(problemCode(dup)).toBe('DOCUMENT_IN_PROGRESS');
  });

  it('credencial live sem habilitação de produção → 403 PRODUCTION_NOT_ENABLED', async () => {
    const live = await createClientApp(t.admin, 'nfse-api-live');
    await t.admin.grantCompany(live.id, companyId);
    const res = await post({ establishmentId, ...sampleDpsData() }, 'e2e-6', await live.key(['nfse:issue'], 'live'));
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('PRODUCTION_NOT_ENABLED');
  });

  it('outra aplicação, ou outro ambiente, não enxerga a nota (404)', async () => {
    const res = await post({ establishmentId, ...sampleDpsData() }, 'e2e-7');
    const id = res.json<{ id: string }>().id;
    expect(problemCode(await get(id, otherAppKey))).toBe('SERVICE_INVOICE_NOT_FOUND');
    const live = await createClientApp(t.admin, 'nfse-api-ambiente');
    await t.admin.grantCompany(live.id, companyId);
    expect(problemCode(await get(id, await live.key(['nfse:read'], 'live')))).toBe('SERVICE_INVOICE_NOT_FOUND');
  });
});
