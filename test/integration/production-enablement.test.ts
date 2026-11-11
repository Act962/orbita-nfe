import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore, type CertificateVault } from '../../src/modules/certificates/public.js';
import { productionEnablementRepository } from '../../src/modules/fiscal-settings/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import {
  bearer,
  cnpjOf,
  createClientApp,
  createCompany,
  createEstablishment,
  fakeRoot,
  problemCode,
  startTestApi,
  testCertificateKek,
  type TestApi,
} from './support/api.js';
import { connect } from './support/db.js';

/**
 * Habilitação de produção por estabelecimento e modalidade (ADR-0027 item 1, regra PROD-001) e
 * ensaio de cadastro `dryRun` (ADR-0026 item 4).
 */
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };

let t: TestApi;
let worker: DatabaseHandle;
let superuser: DatabaseHandle;
let vault: CertificateVault;
let pki: TestIcpPki;
let live: string;
let testKey: string;
let companyId: string;
let root: string;
let establishmentId: string;
let establishmentCnpj: string;

const enablementsUrl = (suffix = ''): string => `/v1/establishments/${establishmentId}/production-enablements${suffix}`;

async function enable(body: Record<string, unknown>, key = live, query = '') {
  return t.app.inject({ method: 'POST', url: enablementsUrl(query), headers: bearer(key, companyId), payload: body });
}

async function auditCount(action: string): Promise<number> {
  const rows = await new CompanyTransactions(t.adminDb.db).run(companyId, (tx) =>
    tx.execute<{ n: string }>(sql`select count(*)::text as n from audit_log where action = ${action}`),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function activeCertificate(): Promise<void> {
  const pfx = pki.pfx({ cnpj: establishmentCnpj, password: 'senha-teste-prod' });
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/certificates`,
    headers: bearer(live, companyId),
    payload: { pfx: pfx.toString('base64'), password: 'senha-teste-prod' },
  });
  expect(res.statusCode).toBe(202);
  const outcome = await vault.validate(companyId, res.json<{ id: string }>().id, WORKER);
  expect(outcome.kind).toBe('ACTIVATED');
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  superuser = connect('superuser', { poolMax: 1 });
  pki = createTestIcpPki();
  vault = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
  }).vault;
  const app = await createClientApp(t.admin, 'prod');
  const scopes = ['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'production:manage', 'webhooks:manage'] as const;
  live = await app.key(scopes, 'live');
  testKey = await app.key(scopes, 'test');
  const company = await createCompany(t.app, live);
  companyId = company.id;
  root = company.root;
  establishmentCnpj = cnpjOf(root);
  establishmentId = await createEstablishment(t.app, live, companyId, establishmentCnpj);
});

afterAll(async () => {
  await worker.close();
  await superuser.close();
  await t.close();
});

describe('habilitação de produção', () => {
  it('credencial test → 403 LIVE_CREDENTIAL_REQUIRED (segunda trava)', async () => {
    const res = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj }, testKey);
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('LIVE_CREDENTIAL_REQUIRED');
  });

  it('sem escopo production:manage → 403 INSUFFICIENT_SCOPE', async () => {
    const app = await createClientApp(t.admin, 'prod-sem-escopo');
    const key = await app.key(['companies:read'], 'live');
    await t.admin.grantCompany(app.id, companyId);
    const res = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj }, key);
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('INSUFFICIENT_SCOPE');
  });

  it('pré-requisitos ausentes → 422 com cada item que falta (PROD-001)', async () => {
    const res = await enable({ kind: 'NFSE_DPS', confirmCnpj: cnpjOf(fakeRoot()) });
    expect(res.statusCode).toBe(422);
    expect(problemCode(res)).toBe('PRODUCTION_PREREQUISITES_NOT_MET');
    const codes = res.json<{ issues: { code: string; ruleId: string }[] }>().issues.map((i) => i.code);
    expect(codes.sort()).toEqual(['PRODUCTION_CERTIFICATE_REQUIRED', 'PRODUCTION_CONFIRMATION_MISMATCH', 'PRODUCTION_SERIES_REQUIRED']);
  });

  it('série de HOMOLOGAÇÃO não serve: precisa ser de produção', async () => {
    const series = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${establishmentId}/document-series`,
      headers: bearer(live, companyId),
      payload: { kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' },
    });
    expect(series.statusCode).toBe(201);
    const res = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj });
    expect(res.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain('PRODUCTION_SERIES_REQUIRED');
  });

  it('com certificado e série de produção: dryRun não grava; habilita; repetição → 409; revoga; habilita de novo', async () => {
    await activeCertificate();
    const series = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${establishmentId}/document-series`,
      headers: bearer(live, companyId),
      payload: { kind: 'NFSE_DPS', environment: 'PRODUCTION', series: '1' },
    });
    expect(series.statusCode).toBe(201);
    const grantedBefore = await auditCount('production_enablement.granted');

    // Ensaio: 200, nada gravado, nada auditado.
    const rehearsal = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') }, live, '?dryRun=true');
    expect(rehearsal.statusCode).toBe(200);
    expect(rehearsal.json()).toMatchObject({ dryRun: true, result: { kind: 'NFSE_DPS', status: 'ACTIVE' } });
    const empty = await t.app.inject({ method: 'GET', url: enablementsUrl(), headers: bearer(live, companyId) });
    expect(empty.json<{ items: unknown[] }>().items).toEqual([]);
    expect(await auditCount('production_enablement.granted')).toBe(grantedBefore);

    const created = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj });
    expect(created.statusCode).toBe(201);
    const first = created.json<{ id: string; status: string; revokedAt: null }>();
    expect(first).toMatchObject({ status: 'ACTIVE', revokedAt: null, establishmentId });
    expect(await auditCount('production_enablement.granted')).toBe(grantedBefore + 1);

    const again = await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj });
    expect(again.statusCode).toBe(409);
    expect(problemCode(again)).toBe('PRODUCTION_ALREADY_ENABLED');

    // Trava L5 (Fase 2a): consulta pelo papel do worker-fiscal.
    const workerTx = new CompanyTransactions(worker.db);
    expect(await workerTx.run(companyId, (tx) => productionEnablementRepository(tx).isEnabled(establishmentId, 'NFSE_DPS'))).toBe(true);
    expect(await workerTx.run(companyId, (tx) => productionEnablementRepository(tx).isEnabled(establishmentId, 'NFE'))).toBe(false);

    const revoke = (key: string) =>
      t.app.inject({ method: 'POST', url: enablementsUrl(`/${first.id}/revocation`), headers: bearer(key, companyId), payload: { reason: 'Troca de emissor' } });
    expect((await revoke(testKey)).statusCode).toBe(403);
    const revoked = await revoke(live);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'REVOKED', revocationReason: 'Troca de emissor' });
    const twice = await revoke(live);
    expect(twice.statusCode).toBe(404);
    expect(problemCode(twice)).toBe('PRODUCTION_ENABLEMENT_NOT_FOUND');
    expect(await workerTx.run(companyId, (tx) => productionEnablementRepository(tx).isEnabled(establishmentId, 'NFSE_DPS'))).toBe(false);

    expect((await enable({ kind: 'NFSE_DPS', confirmCnpj: establishmentCnpj })).statusCode).toBe(201);
    const history = await t.app.inject({ method: 'GET', url: enablementsUrl(), headers: bearer(live, companyId) });
    expect(history.json<{ items: { status: string }[] }>().items.map((i) => i.status).sort()).toEqual(['ACTIVE', 'REVOKED']);
  });

  it('motivo de revogação vazio → 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: enablementsUrl(`/${crypto.randomUUID()}/revocation`),
      headers: bearer(live, companyId),
      payload: { reason: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('habilitação no banco', () => {
  async function asRole(handle: DatabaseHandle, query: ReturnType<typeof sql>) {
    return new CompanyTransactions(handle.db).run(companyId, (tx) => tx.execute(query));
  }

  it('API não apaga; ninguém reativa nem apaga (trigger); worker-fiscal só lê', async () => {
    const rows = await asRole(t.api, sql`select id from production_enablements where status = 'REVOKED' limit 1`);
    const revokedId = String(rows.rows[0]?.['id']);
    await expect(asRole(t.api, sql`delete from production_enablements where id = ${revokedId}`)).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
    await expect(asRole(superuser, sql`update production_enablements set status = 'ACTIVE', revoked_at = null, revocation_reason = null where id = ${revokedId}`)).rejects.toThrow();
    await expect(asRole(superuser, sql`delete from production_enablements where id = ${revokedId}`)).rejects.toThrow();
    await expect(
      asRole(worker, sql`insert into production_enablements (id, company_id, establishment_id, kind) values (gen_random_uuid(), ${companyId}, ${establishmentId}, 'NFE')`),
    ).rejects.toMatchObject({ code: 'DATABASE_ACCESS_VIOLATION' });
  });

  it('estabelecimento de outra empresa não pode ser referenciado (FK composta)', async () => {
    const otherApp = await createClientApp(t.admin, 'prod-outra');
    const otherKey = await otherApp.key(['companies:create', 'companies:manage']);
    const other = await createCompany(t.app, otherKey);
    const otherEstablishment = await createEstablishment(t.app, otherKey, other.id, cnpjOf(other.root));
    await expect(
      asRole(t.api, sql`insert into production_enablements (id, company_id, establishment_id, kind) values (gen_random_uuid(), ${companyId}, ${otherEstablishment}, 'NFE')`),
    ).rejects.toThrow();
  });
});

describe('dryRun nos cadastros', () => {
  it('empresa: 200 sem gravar; repetir sem dryRun cria; dryRun de raiz já cadastrada → 409', async () => {
    const rootCnpj = fakeRoot();
    const rehearsal = await t.app.inject({ method: 'POST', url: '/v1/companies?dryRun=true', headers: bearer(live), payload: { legalName: 'ENSAIO LTDA', rootCnpj } });
    expect(rehearsal.statusCode).toBe(200);
    expect(rehearsal.json()).toMatchObject({ dryRun: true, result: { rootCnpj, status: 'ACTIVE' } });
    expect(rehearsal.headers.location).toBeUndefined();
    const real = await t.app.inject({ method: 'POST', url: '/v1/companies', headers: bearer(live), payload: { legalName: 'ENSAIO LTDA', rootCnpj } });
    expect(real.statusCode).toBe(201);
    expect(real.json<{ id: string }>().id).not.toBe(rehearsal.json<{ result: { id: string } }>().result.id);
    const conflict = await t.app.inject({ method: 'POST', url: '/v1/companies?dryRun=true', headers: bearer(live), payload: { legalName: 'ENSAIO LTDA', rootCnpj } });
    expect(conflict.statusCode).toBe(409);
    expect(problemCode(conflict)).toBe('COMPANY_ALREADY_REGISTERED');
  });

  it('estabelecimento, série e webhook: 200 sem gravar (o webhook de ensaio não devolve segredo)', async () => {
    const establishment = await t.app.inject({
      method: 'POST',
      url: '/v1/establishments?dryRun=true',
      headers: bearer(live, companyId),
      payload: { cnpj: cnpjOf(root, '0002'), tradeName: 'Filial ensaio', municipalityCode: '2211001' },
    });
    expect(establishment.statusCode).toBe(200);
    const list = await t.app.inject({ method: 'GET', url: '/v1/establishments', headers: bearer(live, companyId) });
    expect(list.json<{ items: { id: string }[] }>().items.map((e) => e.id)).toEqual([establishmentId]);

    const before = await t.app.inject({ method: 'GET', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(live, companyId) });
    const series = await t.app.inject({
      method: 'POST',
      url: `/v1/establishments/${establishmentId}/document-series?dryRun=true`,
      headers: bearer(live, companyId),
      payload: { kind: 'NFE', environment: 'PRODUCTION', series: '9' },
    });
    expect(series.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: `/v1/establishments/${establishmentId}/document-series`, headers: bearer(live, companyId) });
    expect(after.json<{ items: unknown[] }>().items.length).toBe(before.json<{ items: unknown[] }>().items.length);

    const webhook = await t.app.inject({
      method: 'POST',
      url: '/v1/webhook-subscriptions?dryRun=true',
      headers: bearer(live, companyId),
      payload: { url: 'http://127.0.0.1:9/ensaio', eventTypes: ['certificate.activated'] },
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.body).not.toContain('whsec_');
    const subscriptions = await t.app.inject({ method: 'GET', url: '/v1/webhook-subscriptions', headers: bearer(live, companyId) });
    expect(subscriptions.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('dryRun com erro de validação devolve o mesmo 400 do cadastro real', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/companies?dryRun=true', headers: bearer(live), payload: { legalName: '', rootCnpj: '123' } });
    expect(res.statusCode).toBe(400);
  });
});
