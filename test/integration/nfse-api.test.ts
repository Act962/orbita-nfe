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
let mainApp: Awaited<ReturnType<typeof createClientApp>>;
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
  mainApp = app;
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

describe('consulta pela referência externa (ADR-0047)', () => {
  const byReference = (reference: string, token = key) =>
    t.app.inject({ method: 'GET', url: `/v1/service-invoices?externalReference=${encodeURIComponent(reference)}`, headers: bearer(token, companyId) });

  it('devolve as notas da referência, da mais nova para a mais antiga, incluindo a rejeitada; outra aplicação ou outro ambiente → lista vazia', async () => {
    const first = await post({ establishmentId, externalReference: 'pedido-ref-1', ...sampleDpsData() }, 'ref-1a');
    expect(first.statusCode).toBe(202);
    const firstId = first.json<{ id: string }>().id;
    // A primeira nota é rejeitada: a referência fica livre e a segunda é aceita.
    gateway.onSubmit('REJECT');
    expect(await fiscalWorker().processor.process(companyId, firstId, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REJECTED' });
    const second = await post({ establishmentId, externalReference: 'pedido-ref-1', ...sampleDpsData() }, 'ref-1b');
    expect(second.statusCode, second.body).toBe(202);
    const secondId = second.json<{ id: string }>().id;

    const res = await byReference('pedido-ref-1');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: { id: string; status: string; externalReference: string }[] }>().items;
    expect(items.map((i) => [i.id, i.status])).toEqual([
      [secondId, 'PENDING'],
      [firstId, 'REJECTED'],
    ]);

    expect((await byReference('pedido-que-nao-existe')).json<{ items: unknown[] }>().items).toEqual([]);
    expect((await byReference('pedido-ref-1', otherAppKey)).json<{ items: unknown[] }>().items).toEqual([]);
    expect((await byReference('pedido-ref-1', await mainApp.key(['nfse:read'], 'live'))).json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('sem a referência, ou vazia → 400', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/service-invoices', headers: bearer(key, companyId) })).statusCode).toBe(400);
    expect((await byReference('')).statusCode).toBe(400);
  });

  it('a referência é por ambiente: ocupada em homologação não bloqueia a produção', async () => {
    expect((await post({ establishmentId, externalReference: 'pedido-ref-amb', ...sampleDpsData() }, 'ref-amb')).statusCode).toBe(202);
    // Mesma aplicação, credencial live: passa da referência e para na habilitação de produção.
    const live = await post({ establishmentId, externalReference: 'pedido-ref-amb', ...sampleDpsData() }, 'ref-amb-live', await mainApp.key(['nfse:issue'], 'live'));
    expect(live.statusCode).toBe(403);
    expect(problemCode(live)).toBe('PRODUCTION_NOT_ENABLED');
  });
});

describe('validação sem efeitos (ADR-0047)', () => {
  const validate = (body: Record<string, unknown>, token = key) =>
    t.app.inject({ method: 'POST', url: '/v1/service-invoices/validation', headers: bearer(token, companyId), payload: body });

  it('DPS válida → 200 com canal e série; nada é numerado, gravado ou enfileirado', async () => {
    const before = await post({ establishmentId, ...sampleDpsData() }, 'valid-antes');
    const n = before.json<{ number: number }>().number;
    const superuser = connect('superuser', { poolMax: 1 });
    const counts = () =>
      superuser.db.execute<{ invoices: number; audit: number; jobs: number }>(
        sql`select (select count(*)::int from service_invoices where company_id = ${companyId}) as invoices,
                   (select count(*)::int from audit_log where company_id = ${companyId}) as audit,
                   (select count(*)::int from jobs where payload->>'companyId' = ${companyId}) as jobs`,
      );
    const start = (await counts()).rows[0];

    const res = await validate({ establishmentId, externalReference: 'pedido-validacao', ...sampleDpsData() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, environment: 'HOMOLOGATION', channel: 'NATIONAL_SEFIN', series: { series: '1' } });
    expect((await validate({ establishmentId, externalReference: 'pedido-validacao', ...sampleDpsData() })).statusCode).toBe(200);

    expect((await counts()).rows[0]).toEqual(start);
    const after = await post({ establishmentId, externalReference: 'pedido-validacao', ...sampleDpsData() }, 'valid-depois');
    expect(after.statusCode).toBe(202);
    expect(after.json<{ number: number }>().number).toBe(n + 1);
    await superuser.close();
  });

  it('os mesmos erros do aceite: 400 XSD, 422 regras do Anexo I, 409 referência ocupada; sem Idempotency-Key', async () => {
    const xsd = await validate({ establishmentId, ...sampleDpsData({ competenceDate: '2026-02-30' }) });
    expect(xsd.statusCode).toBe(400);
    expect(xsd.json<{ issues: { code: string }[] }>().issues[0]?.code).toBe('DPS_SCHEMA_INVALID');

    const rules = await validate({
      establishmentId,
      ...sampleDpsData({ competenceDate: '2099-01-01', taker: { document: { type: 'CNPJ', value: cnpjOf(root) }, name: 'Tomador igual ao prestador' } }),
    });
    expect(rules.statusCode).toBe(422);
    expect(problemCode(rules)).toBe('NFSE_RULES_VIOLATED');
    expect(rules.json<{ issues: { code: string; field: string }[] }>().issues.map((i) => [i.code, i.field])).toEqual([
      ['E0015', 'body.competenceDate'],
      ['E0202', 'body.taker.document'],
      ['E0235', 'body.taker.address'],
    ]);

    expect((await post({ establishmentId, externalReference: 'pedido-validacao-ocupado', ...sampleDpsData() }, 'valid-ocupado')).statusCode).toBe(202);
    const occupied = await validate({ establishmentId, externalReference: 'pedido-validacao-ocupado', ...sampleDpsData() });
    expect(occupied.statusCode).toBe(409);
    expect(problemCode(occupied)).toBe('DOCUMENT_IN_PROGRESS');
  });

  it('credencial live sem habilitação → 403 PRODUCTION_NOT_ENABLED; escopo só de leitura → 403', async () => {
    const live = await validate({ establishmentId, ...sampleDpsData() }, await mainApp.key(['nfse:issue'], 'live'));
    expect(live.statusCode).toBe(403);
    expect(problemCode(live)).toBe('PRODUCTION_NOT_ENABLED');
    const readOnly = await validate({ establishmentId, ...sampleDpsData() }, await mainApp.key(['nfse:read']));
    expect(readOnly.statusCode).toBe(403);
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
      ['E0235', 'body.taker.address'],
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

describe('contrato v2 da DPS (ADR-0040)', () => {
  it('B2B: tomador com CNPJ e endereço, retenção pelo tomador → 202; o worker monta toma/end e tpRetISSQN = 2 válidos no XSD', async () => {
    const address = { municipalityCode: '2211001', postalCode: '64000000', street: 'Av. Ficticia', number: '100', district: 'Centro' };
    const body = {
      establishmentId,
      ...sampleDpsData({
        taker: { document: { type: 'CNPJ', value: '11444777000161' }, name: 'Tomador Ficticio Ltda', address, phone: '86999990000' },
        values: { serviceAmount: '100.00', issqn: { taxation: '1', retention: '2' }, approximateTaxes: { kind: 'AMOUNTS', federal: '0.00', state: '0.00', municipal: '0.00' } },
      }),
    };
    const res = await post(body, 'v2-b2b');
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json<{ id: string }>().id;
    expect(await fiscalWorker().processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_dps: string; layout_package: string }>(sql`select signed_dps, layout_package from service_invoices where id = ${id}`),
    );
    const row = stored.rows[0];
    expect(row?.signed_dps).toContain('<toma><CNPJ>11444777000161</CNPJ><xNome>Tomador Ficticio Ltda</xNome><end><endNac><cMun>2211001</cMun>');
    expect(row?.signed_dps).toContain('<tpRetISSQN>2</tpRetISSQN>');
    expect((await catalog.validate(row?.layout_package ?? '', 'DPS_v1.01.xsd', row?.signed_dps ?? '')).errors).toEqual([]);
  }, 60_000);

  it('formato fora do XSD (CEP com hífen, telefone curto, imunidade fora da lista) → 400 com os campos', async () => {
    const body = {
      establishmentId,
      ...sampleDpsData({
        taker: {
          document: { type: 'CPF', value: '12345678909' },
          name: 'X',
          address: { municipalityCode: '2211001', postalCode: '64000-000', street: 'R', number: '1', district: 'C' },
          phone: '123',
        },
        values: { serviceAmount: '100.00', issqn: { taxation: '2', retention: '1', immunityType: '9' }, approximateTaxes: { kind: 'AMOUNTS', federal: '0.00', state: '0.00', municipal: '0.00' } },
      }),
    };
    const res = await post(body, 'v2-formato');
    expect(res.statusCode).toBe(400);
    const fields = res.json<{ issues: { field: string }[] }>().issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['body.taker.address.postalCode', 'body.taker.phone', 'body.values.issqn.immunityType']));
  });
});

describe('descontos, dedução, exigibilidade suspensa, benefício municipal e tributos federais (ADR-0041 a ADR-0043)', () => {
  const withValues = (values: Record<string, unknown>) => ({
    establishmentId,
    ...sampleDpsData({ values: { serviceAmount: '1000.00', issqn: { taxation: '1', retention: '1' }, approximateTaxes: { kind: 'AMOUNTS', federal: '0.00', state: '0.00', municipal: '0.00' }, ...values } }),
  });

  it('com descontos e retenções federais → 202; o worker monta vDescCondIncond e tribFed válidos no XSD', async () => {
    const body = withValues({
      discounts: { unconditional: '100.00' },
      deduction: { kind: 'AMOUNT', amount: '200.00' },
      issqn: {
        taxation: '1',
        retention: '1',
        suspension: { type: '2', processNumber: '3'.repeat(30) },
        municipalBenefit: { id: '22110010400001', reduction: { kind: 'PERCENTAGE', rate: '10.00' } },
      },
      federalTaxes: { pisCofins: { cst: '01', retentionType: '1' }, incomeTaxWithheld: '15.00', contributionsWithheld: '36.50' },
    });
    const res = await post(body, 'fed-ok');
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json<{ id: string }>().id;
    expect(await fiscalWorker().processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_dps: string; layout_package: string }>(sql`select signed_dps, layout_package from service_invoices where id = ${id}`),
    );
    const row = stored.rows[0];
    // Dedução no grupo do pacote em que a nota foi montada (ADR-0042).
    const deduction = row?.layout_package.endsWith('-prodrest') ? '<vAjusteBC><vAjusteBCISSQN>200.00</vAjusteBCISSQN></vAjusteBC>' : '<vDedRed><vDR>200.00</vDR></vDedRed>';
    expect(row?.signed_dps).toContain(`<vDescCondIncond><vDescIncond>100.00</vDescIncond></vDescCondIncond>${deduction}<trib>`);
    expect(row?.signed_dps).toContain(`<exigSusp><tpSusp>2</tpSusp><nProcesso>${'3'.repeat(30)}</nProcesso></exigSusp><BM><nBM>22110010400001</nBM><pRedBCBM>10.00</pRedBCBM></BM>`);
    expect(row?.signed_dps).toContain('<tribFed><piscofins><CST>01</CST><tpRetPisCofins>1</tpRetPisCofins></piscofins><vRetIRRF>15.00</vRetIRRF><vRetCSLL>36.50</vRetCSLL></tribFed>');
    expect((await catalog.validate(row?.layout_package ?? '', 'DPS_v1.01.xsd', row?.signed_dps ?? '')).errors).toEqual([]);
  }, 60_000);

  it('regras do Anexo I → 422 com os campos; grupos vazios e CST fora da lista → 400', async () => {
    const rules = await post(withValues({ discounts: { conditional: '1000.00' }, federalTaxes: { pisCofins: { cst: '01', retentionType: '0' }, contributionsWithheld: '10.00' } }), 'fed-regras');
    expect(rules.statusCode, rules.body).toBe(422);
    expect(rules.json<{ issues: { code: string; field: string }[] }>().issues.map((i) => [i.code, i.field])).toEqual([
      ['E0432', 'body.values.discounts.conditional'],
      ['E0428', 'body.values'],
      ['E0720', 'body.values.federalTaxes.contributionsWithheld'],
    ]);
    const format = await post(withValues({ discounts: {}, federalTaxes: { pisCofins: { cst: '10' } } }), 'fed-formato');
    expect(format.statusCode).toBe(400);
    const fields = format.json<{ issues: { field: string }[] }>().issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(['body.values.discounts', 'body.values.federalTaxes.pisCofins.cst']));
  });
});

describe('tomador no exterior e exportação (ADR-0044)', () => {
  const taker = {
    document: { type: 'NIF', value: 'PT123456789' },
    name: 'Cliente no exterior',
    address: { countryCode: 'PT', postalCode: '1000-001', city: 'Lisboa', region: 'Lisboa', street: 'Rua Ficticia', number: '1', district: 'Centro' },
  };
  const foreignTrade = { mode: '1', relationship: '0', currencyCode: '978', amountInCurrency: '180.00', providerSupport: '01', takerSupport: '01', temporaryGoods: '1', shareWithMdic: false };
  const exportBody = (service: Record<string, unknown>) => ({
    establishmentId,
    ...sampleDpsData({
      taker,
      service: { ...sampleDpsData().service, ...service },
      values: { serviceAmount: '1000.00', issqn: { taxation: '3', retention: '1', resultCountryCode: 'PT' }, approximateTaxes: { kind: 'AMOUNTS', federal: '0.00', state: '0.00', municipal: '0.00' } },
    }),
  });

  it('prestação no exterior (ADR-0045): sem local ou com os dois → 400; com país, comExt e cNBS → 202', async () => {
    const both = await post(exportBody({ countryCode: 'US', foreignTrade, nbsCode: '115011000' }), 'exp-local-dois');
    expect(both.statusCode).toBe(400);
    expect(both.json<{ issues: { field: string }[] }>().issues.map((i) => i.field)).toContain('body.service.municipalityCode');
    const ok = await post(exportBody({ municipalityCode: undefined, countryCode: 'US', foreignTrade, nbsCode: '115011000' }), 'exp-local-pais');
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it('sem comExt → 422 E0330; com ele → 202 e o worker monta NIF, endExt, comExt e cPaisResult válidos no XSD', async () => {
    const without = await post(exportBody({}), 'exp-sem');
    expect(without.statusCode, without.body).toBe(422);
    expect(without.json<{ issues: { code: string; field: string }[] }>().issues.map((i) => [i.code, i.field])).toEqual([
      ['E0330', 'body.service.foreignTrade'],
      ['E0318', 'body.service.nbsCode'],
    ]);

    const res = await post(exportBody({ foreignTrade, nbsCode: '115011000' }), 'exp-com');
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json<{ id: string }>().id;
    expect(await fiscalWorker().processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ signed_dps: string; layout_package: string }>(sql`select signed_dps, layout_package from service_invoices where id = ${id}`),
    );
    const row = stored.rows[0];
    expect(row?.signed_dps).toContain('<toma><NIF>PT123456789</NIF><xNome>Cliente no exterior</xNome><end><endExt><cPais>PT</cPais>');
    expect(row?.signed_dps).toContain('<comExt><mdPrestacao>1</mdPrestacao>');
    expect(row?.signed_dps).toContain('<tribISSQN>3</tribISSQN><cPaisResult>PT</cPaisResult>');
    expect((await catalog.validate(row?.layout_package ?? '', 'DPS_v1.01.xsd', row?.signed_dps ?? '')).errors).toEqual([]);
  }, 60_000);
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

  /** Filial com a série 10001, a faixa que a DSF aceita por API (THE-002), e o próprio certificado. */
  let dsfEstablishmentId: string;
  beforeAll(async () => {
    dsfEstablishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root, '0002'));
    const series = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${dsfEstablishmentId}/document-series`,
      headers: bearer(key, companyId),
      payload: { kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '10001' },
    });
    expect(series.statusCode, series.body).toBe(201);
    const pfx = pki.pfx({ cnpj: cnpjOf(root, '0002'), password: 'senha-nfse-dsf' });
    const upload = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${dsfEstablishmentId}/certificates`,
      headers: bearer(key, companyId),
      payload: { pfx: pfx.toString('base64'), password: 'senha-nfse-dsf' },
    });
    expect((await fiscalWorker().vault.validate(companyId, upload.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
  });

  it('canal da DSF com série fora de 10001–49999 → 422 THE-002 antes de numerar', async () => {
    const service = { ...sampleDpsData().service, municipalTaxCode: '001' };
    const res = await post({ establishmentId, ...sampleDpsData({ provider: { simplesNacionalOption: '1', specialTaxRegime: '0' }, service }) }, 'rota-dsf-serie');
    expect(res.statusCode, res.body).toBe(422);
    expect(problemCode(res)).toBe('NFSE_RULES_VIOLATED');
    expect(res.json<{ issues: unknown[] }>().issues).toEqual([expect.objectContaining({ code: 'THE-002', field: 'body.seriesId', ruleId: 'NFSE-TERESINA-DSF' })]);
    expect(await invoiceRow('rota-dsf-serie')).toBeUndefined();
  });

  it.each([
    ['não optante em Teresina', { provider: { simplesNacionalOption: '1', specialTaxRegime: '0' } }, 'rota-dsf-nao-optante'],
    ['competência anterior a 11/2026', { competenceDate: '2026-10-31' }, 'rota-dsf-competencia'],
  ])('%s → canal do emissor municipal (DSF, ADR-0039): cTribMun obrigatório (THE-001); com ele, aceita no canal DSF e o worker monta no pacote de 09/02/2026', async (_name, overrides, keyBase) => {
    const establishmentId = dsfEstablishmentId;
    const without = await post({ establishmentId, ...sampleDpsData(overrides) }, `${keyBase}-sem`);
    expect(without.statusCode, without.body).toBe(422);
    expect(problemCode(without)).toBe('NFSE_RULES_VIOLATED');
    expect(without.json<{ issues: { code: string; ruleId: string }[] }>().issues).toContainEqual(expect.objectContaining({ code: 'THE-001', ruleId: 'NFSE-TERESINA-DSF' }));
    expect(await invoiceRow(`${keyBase}-sem`)).toBeUndefined();

    const service = { ...sampleDpsData().service, municipalTaxCode: '001' };
    const accepted = await post({ establishmentId, ...sampleDpsData({ ...overrides, service }) }, `${keyBase}-com`);
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(await invoiceRow(`${keyBase}-com`)).toEqual({ routing_channel: 'MUNICIPAL_TERESINA_DSF', routing_table_version: 'nfse-routing/2026-11-10' });

    const id = accepted.json<{ id: string }>().id;
    expect(await fiscalWorker().processor.process(companyId, id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const stored = await new CompanyTransactions(worker.db).run(companyId, (tx) =>
      tx.execute<{ layout_package: string; signed_dps: string }>(sql`select layout_package, signed_dps from service_invoices where id = ${id}`),
    );
    const row = stored.rows[0];
    expect(row?.layout_package).toBe('nfse-nacional/1.01-20260209');
    expect(row?.signed_dps).not.toContain('<finNFSe>');
    expect((await catalog.validate(row?.layout_package ?? '', 'DPS_v1.01.xsd', row?.signed_dps ?? '')).errors).toEqual([]);
  }, 60_000);

  it.each([
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
