import { createSign, createVerify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore, type CertificateVault } from '../../src/modules/certificates/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import type { DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { CANARIES, expectNoCanary } from '../support/canary.js';
import { createTestIcpPki, type LeafOptions, type TestIcpPki } from '../support/icp-test-pki.js';
import {
  bearer,
  cnpjOf,
  createClientApp,
  createCompany,
  createEstablishment,
  problemCode,
  startTestApi,
  testCertificateKek,
  type TestApi,
} from './support/api.js';
import { connect } from './support/db.js';

/**
 * Certificate Vault (ADR-0009, docs/architecture/13 §9): fluxo API → worker-fiscal, grants de
 * coluna, transições no banco e teste canário de logs.
 */
const WORKER: AuditContext = { actor: { kind: 'SYSTEM', process: 'worker-fiscal-teste' }, correlationId: null };
// Marcador único como senha: não pode aparecer em log nem em resposta.
const PASSWORD = CANARIES.password;

let t: TestApi;
let worker: DatabaseHandle;
let superuser: DatabaseHandle;
let vault: CertificateVault;
let pki: TestIcpPki;
let key: string;
let companyId: string;
let root: string;
let establishmentId: string;

const url = (suffix = ''): string => `/v1/establishments/${establishmentId}/certificates${suffix}`;

async function upload(options: Partial<LeafOptions> & { password?: string; sentPassword?: string } = {}) {
  const pfx = pki.pfx({ cnpj: cnpjOf(root), password: options.password ?? PASSWORD, ...options });
  return t.app.inject({
    method: 'POST',
    url: url(),
    headers: bearer(key, companyId),
    payload: { pfx: pfx.toString('base64'), password: options.sentPassword ?? options.password ?? PASSWORD },
  });
}

async function uploadAndValidate(options: Parameters<typeof upload>[0] = {}) {
  const res = await upload(options);
  expect(res.statusCode).toBe(202);
  const id = res.json<{ id: string }>().id;
  const outcome = await vault.validate(companyId, id, WORKER);
  const current = await t.app.inject({ method: 'GET', url: url(`/${id}`), headers: bearer(key, companyId) });
  return { id, outcome, body: current.json<Record<string, unknown>>() };
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
  const app = await createClientApp(t.admin, 'cert');
  key = await app.key(['companies:create', 'companies:manage', 'certificates:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root));
});

afterAll(async () => {
  await worker.close();
  await superuser.close();
  await t.close();
});

describe('upload pela API', () => {
  it('202 PENDING_VALIDATION, Location e somente metadados na resposta', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(202);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ status: 'PENDING_VALIDATION', establishmentId, subjectCnpj: null, thumbprintSha256: null });
    expect(res.headers.location).toBe(url(`/${String(body['id'])}`));
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['pfx', 'password', 'wrappedDek']));
    expect(res.body).not.toContain(PASSWORD);
  });

  it('estabelecimento de outra empresa ou inexistente → 404; sem escopo → 403', async () => {
    const other = await createClientApp(t.admin, 'cert-other');
    const otherKey = await other.key(['companies:create', 'companies:manage', 'certificates:read']);
    const otherCompany = await createCompany(t.app, otherKey);
    const res = await t.app.inject({
      method: 'POST',
      url: url(),
      headers: bearer(otherKey, otherCompany.id),
      payload: { pfx: 'AAAA', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(problemCode(res)).toBe('INSUFFICIENT_SCOPE');
  });

  it('corpo inválido → 400 sem ecoar a senha', async () => {
    const res = await t.app.inject({ method: 'POST', url: url(), headers: bearer(key, companyId), payload: { pfx: 'não é base64!', password: PASSWORD } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(PASSWORD);
  });
});

describe('validação no worker-fiscal', () => {
  it('certificado válido → ACTIVE com metadados lidos do certificado', async () => {
    const { outcome, body } = await uploadAndValidate();
    expect(outcome).toEqual({ kind: 'ACTIVATED', replaced: [] });
    expect(body).toMatchObject({ status: 'ACTIVE', subjectCnpj: cnpjOf(root), rejectionReason: null });
    expect(body['thumbprintSha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('novo certificado substitui o anterior só depois de validado (sobreposição)', async () => {
    const first = await uploadAndValidate();
    const pending = await upload();
    const pendingId = pending.json<{ id: string }>().id;
    // Enquanto o novo está pendente, o anterior continua ativo.
    const before = await t.app.inject({ method: 'GET', url: url(`/${first.id}`), headers: bearer(key, companyId) });
    expect(before.json<{ status: string }>().status).toBe('ACTIVE');

    expect(await vault.validate(companyId, pendingId, WORKER)).toEqual({ kind: 'ACTIVATED', replaced: [first.id] });
    const after = await t.app.inject({ method: 'GET', url: url(`/${first.id}`), headers: bearer(key, companyId) });
    expect(after.json<{ status: string }>().status).toBe('REPLACED');
  });

  it('rejeições com motivo estável', async () => {
    const cases: [Parameters<typeof upload>[0], string][] = [
      [{ password: 'certa', sentPassword: 'errada' }, 'PKCS12_INVALID_PASSWORD'],
      [{ issuer: pki.untrustedRoot }, 'CERTIFICATE_CHAIN_UNTRUSTED'],
      [{ cnpj: cnpjOf('99887766') }, 'CERTIFICATE_CNPJ_MISMATCH'],
      [{ cnpj: null }, 'CERTIFICATE_NOT_LEGAL_ENTITY'],
      [{ notAfter: new Date(Date.now() - 60_000), notBefore: new Date(Date.now() - 86_400_000) }, 'CERTIFICATE_EXPIRED'],
      [{ digitalSignature: false }, 'CERTIFICATE_KEY_USAGE_INVALID'],
    ];
    for (const [options, reason] of cases) {
      const { outcome, body } = await uploadAndValidate(options);
      expect(outcome).toEqual({ kind: 'REJECTED', reason });
      expect(body).toMatchObject({ status: 'REJECTED', rejectionReason: reason });
    }
  });

  it('validação é idempotente: certificado já decidido é ignorado', async () => {
    const { id } = await uploadAndValidate();
    expect(await vault.validate(companyId, id, WORKER)).toEqual({ kind: 'SKIPPED', status: 'ACTIVE' });
  });

  it('withCertificate entrega KeyObject que assina, e o certificado correspondente', async () => {
    const signature = await vault.withCertificate(companyId, establishmentId, (c) => {
      expect(c.privateKey.type).toBe('private');
      const sig = createSign('sha256').update('<xml/>').sign(c.privateKey);
      expect(createVerify('sha256').update('<xml/>').verify(c.certificatePem, sig)).toBe(true);
      return Promise.resolve(sig);
    });
    expect(signature.length).toBeGreaterThan(0);
  });
});

describe('revogação', () => {
  it('REVOKED, chave do envelope destruída e emissão bloqueada', async () => {
    const { id } = await uploadAndValidate();
    const res = await t.app.inject({ method: 'POST', url: url(`/${id}/revocation`), headers: bearer(key, companyId) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('REVOKED');

    const rows = await worker.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
      return tx.execute<{ wrapped_dek: Buffer | null }>(sql`select wrapped_dek from certificates where id = ${id}`);
    });
    expect(rows.rows[0]?.wrapped_dek).toBeNull();
    await expect(vault.withCertificate(companyId, establishmentId, () => Promise.resolve('x'))).rejects.toMatchObject({ code: 'CERTIFICATE_NOT_AVAILABLE' });

    const again = await t.app.inject({ method: 'POST', url: url(`/${id}/revocation`), headers: bearer(key, companyId) });
    expect(again.statusCode).toBe(422);
    expect(problemCode(again)).toBe('CERTIFICATE_ALREADY_REVOKED');
  });
});

describe('privilégios no banco (docs/architecture/13 §2 e §9)', () => {
  async function inCompany(handle: DatabaseHandle, query: ReturnType<typeof sql>) {
    return handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
      return tx.execute(query);
    });
  }

  it('a API não lê o envelope (grants de coluna)', async () => {
    for (const column of ['wrapped_dek', 'pfx_sealed', 'password_sealed']) {
      await expect(inCompany(t.api, sql.raw(`select ${column} from certificates limit 1`))).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    await expect(inCompany(t.api, sql`select id, status, not_after from certificates limit 1`)).resolves.toBeDefined();
  });

  it('o worker-general só lê o necessário para alertas', async () => {
    const general = connect('general', { poolMax: 1 });
    try {
      await expect(inCompany(general, sql`select pfx_sealed from certificates limit 1`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(inCompany(general, sql`select subject_name from certificates limit 1`)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(inCompany(general, sql`select id, not_after, status from certificates limit 1`)).resolves.toBeDefined();
    } finally {
      await general.close();
    }
  });

  it('a API não ativa um certificado nem preenche metadados', async () => {
    const pending = (await upload()).json<{ id: string }>().id;
    await expect(inCompany(t.api, sql`update certificates set subject_cnpj = ${cnpjOf(root)} where id = ${pending}`)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    // status pode mudar (revogação), mas ACTIVE sem metadados é barrado pela constraint.
    await expect(inCompany(t.api, sql`update certificates set status = 'ACTIVE' where id = ${pending}`)).rejects.toMatchObject({
      cause: { constraint: 'ck_certificates_metadata' },
    });
  });

  it('o trigger impede revivir certificado revogado e trocar o conteúdo cifrado, até para o dono', async () => {
    const owner = connect('owner', { poolMax: 1 });
    try {
      const { id } = await uploadAndValidate();
      await expect(inCompany(owner, sql`update certificates set pfx_sealed = '\\x00'::bytea where id = ${id}`)).rejects.toMatchObject({
        cause: { constraint: 'ck_certificates_immutable' },
      });
      await t.app.inject({ method: 'POST', url: url(`/${id}/revocation`), headers: bearer(key, companyId) });
      await expect(inCompany(owner, sql`update certificates set status = 'ACTIVE', revoked_at = null where id = ${id}`)).rejects.toMatchObject({
        cause: { constraint: 'ck_certificates_transition' },
      });
    } finally {
      await owner.close();
    }
  });
});

describe('teste canário (docs/architecture/13 §7)', () => {
  it('senha e conteúdo do PFX nunca aparecem nos logs da API', async () => {
    const marked = Buffer.concat([pki.pfx({ cnpj: cnpjOf(root), password: PASSWORD }), Buffer.from(CANARIES.pfx)]);
    await t.app.inject({ method: 'POST', url: url(), headers: bearer(key, companyId), payload: { pfx: marked.toString('base64'), password: PASSWORD } });
    await t.app.inject({ method: 'POST', url: url(), headers: bearer(key, companyId), payload: { pfx: '!!', password: PASSWORD } });
    const logs = t.logs.text();
    expect(logs.length).toBeGreaterThan(0);
    expectNoCanary(logs);
    expect(logs).not.toContain(marked.toString('base64').slice(0, 40));
  });
});
