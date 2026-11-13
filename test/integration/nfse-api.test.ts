import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import { SimulatedNfseGateway, XmlCancellationPreparer, XmlDpsPreparer, XmlNfseVerifier } from '../../src/modules/nfse/public.js';
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
    nfse: { gateway, preparer: new XmlDpsPreparer(catalog, 'orbita-nfe-teste'), verifier: new XmlNfseVerifier(catalog), alerts: { raise: () => undefined }, cancellationPreparer: new XmlCancellationPreparer(catalog, 'orbita-nfe-teste') },
  });
  if (composed.processor === undefined || composed.cancellations === undefined) throw new Error('nfse não composto');
  return { vault: composed.vault, processor: composed.processor, cancellations: composed.cancellations };
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  pki = createTestIcpPki();
  catalog = FiscalSchemaCatalog.load(ROOT);
  const app = await createClientApp(t.admin, 'nfse-api');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'nfse:issue', 'nfse:read', 'nfse:cancel']);
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
    expect(after.json<{ status: string; accessKey: string | null }>()).toMatchObject({ status: 'AUTHORIZED', accessKey: expect.stringMatching(/^000000022\d{41}$/) as unknown });
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

describe('regras do Anexo I no aceite (ADR-0037)', () => {
  it('violações → 422 NFSE_RULES_VIOLATED com todas as regras e campos, antes de numerar', async () => {
    const body = {
      establishmentId,
      ...sampleDpsData({
        competenceDate: '2099-01-01',
        taker: { document: { type: 'CNPJ', value: cnpjOf(root) }, name: 'Tomador igual ao prestador' },
      }),
    };
    const res = await post(body, 'regras-1');
    expect(res.statusCode, res.body).toBe(422);
    expect(problemCode(res)).toBe('NFSE_RULES_VIOLATED');
    const issues = res.json<{ issues: { code: string; field: string; ruleId: string }[] }>().issues;
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ['E0015', 'body.competenceDate'],
      ['E0202', 'body.taker.document'],
      ['E0235', 'body.taker'],
    ]);
    expect(issues.every((i) => i.ruleId === 'NFSE-DPS')).toBe(true);
    const written = await new CompanyTransactions(t.api.db).run(companyId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from service_invoices where idempotency_key = 'regras-1'`),
    );
    expect(written.rows[0]?.n).toBe(0);
    // A mesma DPS sem as violações é aceita.
    expect((await post({ establishmentId, ...sampleDpsData() }, 'regras-2')).statusCode).toBe(202);
  });
});

describe('roteamento pela competência (ADR-0028)', () => {
  const invoiceRow = (idempotencyKey: string) =>
    new CompanyTransactions(t.api.db).run(companyId, async (tx) => {
      const rows = await tx.execute<{ routing_channel: string | null; routing_table_version: string | null }>(
        sql`select routing_channel, routing_table_version from service_invoices where idempotency_key = ${idempotencyKey}`,
      );
      return rows.rows[0];
    });

  it('ME/EPP no sublimite, competência ≥ 11/2026 em Teresina: aceita e grava o canal e a versão da tabela', async () => {
    const res = await post({ establishmentId, ...sampleDpsData() }, 'rota-ok');
    expect(res.statusCode).toBe(202);
    expect(await invoiceRow('rota-ok')).toEqual({ routing_channel: 'NATIONAL_SEFIN', routing_table_version: 'nfse-routing/2026-11-10' });
    // O canal gravado não muda depois (identidade imutável, trigger).
    const id = res.json<{ id: string }>().id;
    await expect(
      new CompanyTransactions(worker.db).run(companyId, (tx) => tx.execute(sql`update service_invoices set routing_channel = 'MUNICIPAL_TERESINA_DSF' where id = ${id}`)),
    ).rejects.toThrow();
  });

  it.each([
    ['competência anterior a 11/2026 (emissor municipal)', { competenceDate: '2026-10-31' }, 'ROUTE_CHANNEL_NOT_SUPPORTED'],
    ['não optante em Teresina (emissor municipal)', { provider: { simplesNacionalOption: '1', specialTaxRegime: '0' } }, 'ROUTE_CHANNEL_NOT_SUPPORTED'],
    ['ME/EPP fora do sublimite (linha a confirmar)', { provider: { simplesNacionalOption: '3', simplesNacionalRegime: '2', specialTaxRegime: '0' } }, 'ROUTE_PENDING_CONFIRMATION'],
    ['ME/EPP sem o regime informado', { provider: { simplesNacionalOption: '3', specialTaxRegime: '0' } }, 'ROUTE_REGIME_REQUIRED'],
    ['MEI com competência anterior em Teresina (regras conflitantes)', { competenceDate: '2026-10-31', provider: { simplesNacionalOption: '2', specialTaxRegime: '0' } }, 'ROUTE_AMBIGUOUS'],
  ])('%s → 422 NFSE_CHANNEL_NOT_AVAILABLE (%s), sem numerar', async (_name, overrides, reason) => {
    const idempotencyKey = `rota-${reason}-${String(Object.keys(overrides).length)}-${_name.length}`;
    const res = await post({ establishmentId, ...sampleDpsData(overrides) }, idempotencyKey);
    expect(res.statusCode).toBe(422);
    expect(problemCode(res)).toBe('NFSE_CHANNEL_NOT_AVAILABLE');
    expect(JSON.stringify(res.json())).toContain(reason);
    expect(await invoiceRow(idempotencyKey)).toBeUndefined();
  });
});

describe('substituição pela API (ADR-0036)', () => {
  const substitute = (id: string, body: Record<string, unknown>, idempotencyKey: string, apiKey = key) =>
    t.app.inject({ method: 'POST', url: `/v1/service-invoices/${id}/substitution`, headers: { ...bearer(apiKey, companyId), 'idempotency-key': idempotencyKey }, payload: body });
  const reason = { reasonCode: '99', reasonText: 'Correção da descrição do serviço' };

  it('nota autorizada → 202 substituta PENDING → worker monta a DPS real com subst → AUTHORIZED; original SUBSTITUTED', async () => {
    const issued = await post({ establishmentId, ...sampleDpsData() }, 'subst-e2e-1');
    const originalId = issued.json<{ id: string }>().id;
    const w = fiscalWorker();
    await w.processor.process(companyId, originalId, WORKER);
    const originalKey = (await get(originalId)).json<{ accessKey: string }>().accessKey;

    const body = { ...sampleDpsData({ service: { ...sampleDpsData().service, description: 'Descricao corrigida' } }), substitution: reason };
    const res = await substitute(originalId, body, 'subst-e2e-1-a');
    expect(res.statusCode, res.body).toBe(202);
    const accepted = res.json<{ id: string; status: string; substitution: unknown; establishmentId: string }>();
    expect(accepted).toMatchObject({ status: 'PENDING', establishmentId, substitution: { serviceInvoiceId: originalId, reasonCode: '99', reasonText: reason.reasonText } });
    expect(res.headers.location).toBe(`/v1/service-invoices/${accepted.id}`);
    expect((await substitute(originalId, body, 'subst-e2e-1-a')).statusCode).toBe(200);

    expect(await w.processor.process(companyId, accepted.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    expect((await get(originalId)).json()).toMatchObject({ status: 'SUBSTITUTED', substitutedById: accepted.id });
    expect((await get(accepted.id)).json()).toMatchObject({ status: 'AUTHORIZED', substitutedById: null });

    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_dps: string; layout_package: string }>(sql`select signed_dps, layout_package from service_invoices where id = ${accepted.id}`),
    );
    const row = stored.rows[0];
    if (row === undefined) throw new Error('substituta não encontrada');
    expect(row.signed_dps).toContain(`<subst><chSubstda>${originalKey}</chSubstda><cMotivo>99</cMotivo>`);
    expect((await catalog.validate(row.layout_package, 'DPS_v1.01.xsd', row.signed_dps)).errors).toEqual([]);
  }, 60_000);

  it('motivo fora do XSD ou 99 sem texto → 400; campo travado (E0063) → 422 com o campo; nota não autorizada → 422; outra aplicação → 404', async () => {
    const issued = await post({ establishmentId, ...sampleDpsData() }, 'subst-e2e-2');
    const id = issued.json<{ id: string }>().id;
    expect((await substitute(id, { ...sampleDpsData(), substitution: { reasonCode: '1' } }, 'subst-e2e-2-a')).statusCode).toBe(400);
    expect((await substitute(id, { ...sampleDpsData(), substitution: { reasonCode: '99' } }, 'subst-e2e-2-b')).statusCode).toBe(400);
    expect((await substitute(id, { establishmentId, ...sampleDpsData(), substitution: reason }, 'subst-e2e-2-c')).statusCode).toBe(400);
    const pending = await substitute(id, { ...sampleDpsData(), substitution: reason }, 'subst-e2e-2-d');
    expect(pending.statusCode).toBe(422);
    expect(problemCode(pending)).toBe('SERVICE_INVOICE_NOT_AUTHORIZED');

    await fiscalWorker().processor.process(companyId, id, WORKER);
    const locked = await substitute(id, { ...sampleDpsData({ competenceDate: '2026-11-12' }), substitution: reason }, 'subst-e2e-2-e');
    expect(locked.statusCode).toBe(422);
    expect(problemCode(locked)).toBe('SUBSTITUTION_LOCKED_FIELDS');
    expect(JSON.stringify(locked.json())).toContain('competenceDate');
    const other = await substitute(id, { ...sampleDpsData(), substitution: reason }, 'subst-e2e-2-f', otherAppKey);
    expect(other.statusCode).toBe(404);
  });
});

describe('cancelamento pela API (ADR-0035)', () => {
  const cancel = (id: string, body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: `/v1/service-invoices/${id}/cancellation`, headers: bearer(key, companyId), payload: body });
  const getCancellation = (id: string) => t.app.inject({ method: 'GET', url: `/v1/service-invoices/${id}/cancellation`, headers: bearer(key, companyId) });
  const reason = { reasonCode: '1', reasonText: 'Erro na emissão: valor digitado errado' };

  it('nota autorizada → 202 PENDING → worker assina e valida o pedido real → REGISTERED; nota CANCELLED', async () => {
    const issued = await post({ establishmentId, ...sampleDpsData() }, 'cancel-e2e-1');
    const id = issued.json<{ id: string }>().id;
    const w = fiscalWorker();
    await w.processor.process(companyId, id, WORKER);

    const res = await cancel(id, reason);
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe(`/v1/service-invoices/${id}/cancellation`);
    const cancellationId = res.json<{ id: string; status: string }>().id;
    expect(res.json<{ status: string }>().status).toBe('PENDING');
    expect((await cancel(id, reason)).statusCode).toBe(200);

    expect(await w.cancellations.process(companyId, cancellationId, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REGISTERED' });
    expect((await getCancellation(id)).json()).toMatchObject({ id: cancellationId, status: 'REGISTERED', reasonCode: '1' });
    expect((await get(id)).json()).toMatchObject({ status: 'CANCELLED' });

    // O pedido transmitido é o XML real, assinado pelo certificado do prestador.
    const signed = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_xml: string }>(sql`select signed_xml from service_invoice_cancellations where id = ${cancellationId}`),
    );
    expect(signed.rows[0]?.signed_xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc>');
  });

  it('motivo fora de TSCodJustCanc/TSMotivo → 400; nota não autorizada → 422; outra aplicação → 404', async () => {
    const issued = await post({ establishmentId, ...sampleDpsData() }, 'cancel-e2e-2');
    const id = issued.json<{ id: string }>().id;
    expect((await cancel(id, { reasonCode: '3', reasonText: reason.reasonText })).statusCode).toBe(400);
    expect((await cancel(id, { reasonCode: '1', reasonText: 'curto' })).statusCode).toBe(400);
    const pending = await cancel(id, reason);
    expect(pending.statusCode).toBe(422);
    expect(problemCode(pending)).toBe('SERVICE_INVOICE_NOT_AUTHORIZED');
    const other = await t.app.inject({ method: 'POST', url: `/v1/service-invoices/${id}/cancellation`, headers: bearer(otherAppKey, companyId), payload: reason });
    expect([403, 404]).toContain(other.statusCode);
    expect(problemCode(await getCancellation(id))).toBe('CANCELLATION_NOT_FOUND');
  });
});
