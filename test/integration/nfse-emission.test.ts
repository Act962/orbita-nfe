import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeFiscalWorker } from '../../src/main/compose.js';
import { X509TrustStore } from '../../src/modules/certificates/public.js';
import {
  SimulatedNfseGateway,
  type DpsPreparer,
  type NfseGateway,
  type PreparationResult,
  type Reconciler,
  type ServiceInvoice,
  type SubmissionProcessor,
} from '../../src/modules/nfse/public.js';
import type { AuditContext } from '../../src/shared/application/audit.js';
import { CompanyTransactions, type DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, testCertificateKek, type ClientApp, type TestApi } from './support/api.js';
import { connect, newId } from './support/db.js';

/**
 * Núcleo da emissão de NFS-e (ADR-0032) contra o PostgreSQL real e o SIMULADOR do autorizador.
 * Cobre os testes obrigatórios do doc 12 §9: quedas em cada ponto, "processa e derruba",
 * consistência eventual, retransmissão byte a byte, indisponibilidade longa e idempotência sob
 * concorrência.
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
let root: string;
let establishmentId: string;

/** Relógio controlado pelo teste; `crashOnNextNow` simula a queda do processo no próximo uso. */
let clock = new Date();
let crashOnNextNow = false;
const now = (): Date => {
  if (crashOnNextNow) {
    crashOnNextNow = false;
    throw new Error('QUEDA_SIMULADA');
  }
  return clock;
};
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

/** Preparador de teste: só embrulha o Id (o preparador real é a próxima etapa). */
class FakePreparer implements DpsPreparer {
  next: 'OK' | 'FAIL' | 'CRASH_AFTER' | 'HANG' = 'OK';
  calls = 0;
  prepare(invoice: ServiceInvoice): Promise<PreparationResult> {
    this.calls++;
    const mode = this.next;
    this.next = 'OK';
    if (mode === 'FAIL') return Promise.resolve({ ok: false, code: 'DPS_SCHEMA_INVALID' });
    if (mode === 'HANG') return new Promise(() => undefined);
    if (mode === 'CRASH_AFTER') crashOnNextNow = true;
    return Promise.resolve({ ok: true, signedXml: `<DPS><infDPS Id="${invoice.dpsId}"><teste>${this.calls}</teste></infDPS><Signature/></DPS>`, layoutPackage: 'teste/sem-xsd' });
  }
}

/** Gateway que nunca responde: o processo "morre" depois do SENDING. */
class HangingGateway implements NfseGateway {
  submit(): Promise<never> {
    return new Promise(() => undefined);
  }
  findByDpsId(): Promise<never> {
    return new Promise(() => undefined);
  }
}

let gateway: SimulatedNfseGateway;
let preparer: FakePreparer;
let processor: SubmissionProcessor;
let reconciler: Reconciler;

function buildWorker(g: NfseGateway = gateway) {
  const composed = composeFiscalWorker({
    db: worker.db,
    certificateKeks: [testCertificateKek().privateKey],
    trustStore: X509TrustStore.fromPem(pki.trustBundlePem),
    nfse: { gateway: g, preparer },
    now,
  });
  if (composed.processor === undefined || composed.reconciler === undefined) throw new Error('nfse não composto');
  return { ...composed, processor: composed.processor, reconciler: composed.reconciler };
}

async function activateCertificate(establishment: string, cnpj: string): Promise<void> {
  const pfx = pki.pfx({ cnpj, password: 'senha-teste-nfse' });
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishment}/certificates`,
    headers: bearer(key, companyId),
    payload: { pfx: pfx.toString('base64'), password: 'senha-teste-nfse' },
  });
  expect(res.statusCode).toBe(202);
  expect((await buildWorker().vault.validate(companyId, res.json<{ id: string }>().id, WORKER)).kind).toBe('ACTIVATED');
}

async function createSeries(establishment: string, series: string, environment = 'HOMOLOGATION'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishment}/document-series`,
    headers: bearer(key, companyId),
    payload: { kind: 'NFSE_DPS', environment, series },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

let keySeq = 0;
function accept(overrides: Partial<Parameters<TestApi['modules']['nfse']['accept']>[0]> = {}) {
  const idempotencyKey = overrides.idempotencyKey ?? `idem-${process.pid}-${++keySeq}`;
  return t.modules.nfse.accept(
    {
      companyId,
      clientApplicationId: app.id,
      environment: 'HOMOLOGATION',
      establishmentId,
      idempotencyKey,
      requestHash: createHash('sha256').update(idempotencyKey).digest('hex'),
      externalReference: null,
      payload: { descricao: 'Servico ficticio' },
      ...overrides,
    },
    API,
  );
}

async function state(invoiceId: string) {
  return new CompanyTransactions(t.api.db).run(companyId, async (tx) => {
    const invoice = await tx.execute<{ status: string; failure_code: string | null; nfse_access_key: string | null; signed_dps_sha256: string | null }>(
      sql`select status, failure_code, nfse_access_key, signed_dps_sha256 from service_invoices where id = ${invoiceId}`,
    );
    const attempts = await tx.execute<{ seq: number; state: string; outcome: string | null; payload_sha256: string; lookups: number }>(
      sql`select seq, state, outcome, payload_sha256, lookups from service_invoice_attempts where invoice_id = ${invoiceId} order by seq`,
    );
    const events = await tx.execute<{ data: { status: string } }>(
      sql`select data from outbox_events where subject_id = ${invoiceId} and type = 'service_invoice.status_changed' order by occurred_at`,
    );
    return { ...invoice.rows[0], attempts: attempts.rows, events: events.rows.map((e) => e.data.status) };
  });
}

async function jobs(invoiceId: string, queue: string) {
  const rows = await t.adminDb.db.execute<{ singleton_key: string; run_at: Date; state: string }>(
    sql`select singleton_key, run_at, state from jobs where queue = ${queue} and payload->>'invoiceId' = ${invoiceId} order by created_at`,
  );
  return rows.rows;
}

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker', { poolMax: 10 });
  pki = createTestIcpPki();
  app = await createClientApp(t.admin, 'nfse');
  key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage', 'nfse:issue']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  root = company.root;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(root));
  preparer = new FakePreparer();
  gateway = new SimulatedNfseGateway();
  await activateCertificate(establishmentId, cnpjOf(root));
  await createSeries(establishmentId, '1');
});

afterAll(async () => {
  await worker.close();
  await t.close();
});

beforeEach(() => {
  clock = new Date();
  crashOnNextNow = false;
  gateway = new SimulatedNfseGateway();
  preparer = new FakePreparer();
  ({ processor, reconciler } = buildWorker());
});

describe('aceite', () => {
  it('numera, monta o Id da DPS, grava PENDING e agenda nfse.process no mesmo commit', async () => {
    const { invoice, replayed } = await accept();
    expect(replayed).toBe(false);
    expect(invoice.status).toBe('PENDING');
    expect(invoice.dpsId).toBe(`DPS22110012${cnpjOf(root)}00001${String(invoice.number).padStart(15, '0')}`);
    expect(await jobs(invoice.id, 'nfse.process')).toMatchObject([{ singleton_key: invoice.id, state: 'queued' }]);
  });

  it('mesma Idempotency-Key e mesmo pedido: o mesmo documento; pedido diferente: IDEMPOTENCY_KEY_REUSED', async () => {
    const first = await accept({ idempotencyKey: 'chave-repetida-1' });
    const again = await accept({ idempotencyKey: 'chave-repetida-1' });
    expect(again).toMatchObject({ replayed: true, invoice: { id: first.invoice.id, number: first.invoice.number } });
    await expect(accept({ idempotencyKey: 'chave-repetida-1', requestHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('50 requisições paralelas com a mesma chave: um único documento e um único número', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => accept({ idempotencyKey: 'chave-paralela' })));
    const ids = new Set(results.map((r) => r.invoice.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const [id] = [...ids];
    const count = await new CompanyTransactions(t.api.db).run(companyId, (tx) =>
      tx.execute<{ n: string }>(sql`select count(*)::text as n from service_invoices where idempotency_key = 'chave-paralela'`),
    );
    expect(count.rows[0]?.n).toBe('1');
    expect(id).toBeDefined();
  });

  it('referência externa ocupada → DOCUMENT_IN_PROGRESS; depois de REJECTED, pode ser reutilizada', async () => {
    const first = await accept({ externalReference: 'pedido-123' });
    await expect(accept({ externalReference: 'pedido-123' })).rejects.toMatchObject({ code: 'DOCUMENT_IN_PROGRESS' });
    gateway.onSubmit('REJECT').rejectWith('E0123', 'Rejeição de teste');
    expect(await processor.process(companyId, first.invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'REJECTED' });
    const second = await accept({ externalReference: 'pedido-123' });
    expect(second.invoice.id).not.toBe(first.invoice.id);
    expect(await state(first.invoice.id)).toMatchObject({ status: 'REJECTED', events: ['REJECTED'] });
  });

  it('produção sem habilitação → PRODUCTION_NOT_ENABLED', async () => {
    await expect(accept({ environment: 'PRODUCTION' })).rejects.toMatchObject({ code: 'PRODUCTION_NOT_ENABLED' });
  });

  it('sem série ativa no ambiente → NFSE_SERIES_NOT_AVAILABLE', async () => {
    const other = await createEstablishment(t.app, key, companyId, cnpjOf(root, '0002'));
    await expect(accept({ establishmentId: other })).rejects.toMatchObject({ code: 'NFSE_SERIES_NOT_AVAILABLE' });
  });
});

describe('transmissão (write-ahead)', () => {
  it('caminho feliz: PENDING → PROCESSING → AUTHORIZED, uma recepção, webhook AUTHORIZED', async () => {
    const { invoice } = await accept();
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const s = await state(invoice.id);
    expect(s).toMatchObject({ status: 'AUTHORIZED', events: ['AUTHORIZED'], attempts: [{ seq: 1, state: 'CLOSED', outcome: 'AUTHORIZED' }] });
    expect(s.nfse_access_key).toMatch(/^SIM/);
    expect(gateway.received.get(invoice.dpsId)).toBe(1);
    // Rodar o job de novo não transmite outra vez.
    expect(await processor.process(companyId, invoice.id, WORKER)).toMatchObject({ kind: 'SKIPPED', reason: 'NOT_PENDING' });
    expect(gateway.submits).toBe(1);
  });

  it('NOT_SENT → volta a PENDING com novo job agendado; o reenvio usa os mesmos bytes', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('NOT_SENT');
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'NOT_SENT' });
    expect(await state(invoice.id)).toMatchObject({ status: 'PENDING', events: [] });
    const resend = (await jobs(invoice.id, 'nfse.process')).find((j) => j.singleton_key === `${invoice.id}:resend:1`);
    expect(resend !== undefined && new Date(resend.run_at).getTime()).toBeGreaterThan(clock.getTime());

    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const s = await state(invoice.id);
    expect(s.attempts.map((a) => a.outcome)).toEqual(['NOT_SENT', 'AUTHORIZED']);
    expect(s.attempts[0]?.payload_sha256).toBe(s.attempts[1]?.payload_sha256);
    expect(preparer.calls).toBe(1);
  });

  it('falha local na preparação → FAILED (nada foi enviado), webhook FAILED', async () => {
    const { invoice } = await accept();
    preparer.next = 'FAIL';
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'FAILED', code: 'DPS_SCHEMA_INVALID' });
    expect(await state(invoice.id)).toMatchObject({ status: 'FAILED', failure_code: 'DPS_SCHEMA_INVALID', attempts: [], events: ['FAILED'] });
    expect(gateway.submits).toBe(0);
  });

  it('estabelecimento sem certificado → FAILED CERTIFICATE_NOT_AVAILABLE antes de qualquer envio', async () => {
    const other = await createEstablishment(t.app, key, companyId, cnpjOf(root, '0003'));
    await createSeries(other, '1');
    const { invoice } = await accept({ establishmentId: other });
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'FAILED', code: 'CERTIFICATE_NOT_AVAILABLE' });
    expect(gateway.submits).toBe(0);
  });
});

describe('quedas em cada ponto (doc 12 §9, teste 1)', () => {
  it('queda antes da tentativa (durante a preparação): concessão vence → PENDING → segue e autoriza', async () => {
    const { invoice } = await accept();
    preparer.next = 'HANG';
    void processor.process(companyId, invoice.id, WORKER);
    await waitFor(async () => (await state(invoice.id)).status === 'PROCESSING');

    // Concessão ainda válida: outro processamento não mexe.
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'SKIPPED', reason: 'LEASED' });
    advance(3 * MIN);
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    expect(gateway.received.get(invoice.dpsId)).toBe(1);
  });

  it('queda com a tentativa PREPARED: é certo que nada saiu → RECOVERED_NOT_SENT → reenvia e autoriza', async () => {
    const { invoice } = await accept();
    preparer.next = 'CRASH_AFTER';
    await expect(processor.process(companyId, invoice.id, WORKER)).rejects.toThrow('QUEDA_SIMULADA');
    expect(await state(invoice.id)).toMatchObject({ status: 'PROCESSING', attempts: [{ seq: 1, state: 'PREPARED' }] });
    expect(gateway.submits).toBe(0);

    advance(3 * MIN);
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const s = await state(invoice.id);
    expect(s.attempts.map((a) => a.outcome)).toEqual(['RECOVERED_NOT_SENT', 'AUTHORIZED']);
    expect(preparer.calls).toBe(1);
  });

  it('queda depois do SENDING: pode ter sido enviado → UNKNOWN → consulta, nunca reenvio direto', async () => {
    const { invoice } = await accept();
    const hanging = buildWorker(new HangingGateway()).processor;
    void hanging.process(companyId, invoice.id, WORKER);
    await waitFor(async () => (await state(invoice.id)).attempts[0]?.state === 'SENDING');

    advance(3 * MIN);
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'UNKNOWN' });
    expect(await state(invoice.id)).toMatchObject({ status: 'UNKNOWN', events: ['UNKNOWN'], attempts: [{ outcome: 'RECOVERED_UNKNOWN' }] });
    expect(gateway.submits).toBe(0);
    expect(await jobs(invoice.id, 'nfse.reconcile')).toHaveLength(1);
  });
});

describe('UNKNOWN e reconciliação (doc 12 §9, testes 2 a 5)', () => {
  it('"processa e derruba a conexão" → UNKNOWN → consulta → AUTHORIZED sem nova transmissão', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('PROCESS_THEN_DROP');
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'UNKNOWN' });
    const [lookup] = await jobs(invoice.id, 'nfse.reconcile');
    expect(lookup !== undefined && new Date(lookup.run_at).getTime()).toBe(clock.getTime() + 2 * MIN);

    // Antes da espera mínima: não consulta.
    expect((await reconciler.reconcile(companyId, invoice.id, WORKER)).kind).toBe('WAITING');
    expect(gateway.lookups).toBe(0);
    advance(2 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toEqual({ kind: 'AUTHORIZED' });
    expect(await state(invoice.id)).toMatchObject({ status: 'AUTHORIZED', events: ['UNKNOWN', 'AUTHORIZED'] });
    expect(gateway.received.get(invoice.dpsId)).toBe(1);
  });

  it('consistência eventual: "não encontrado" e depois "encontrado" → AUTHORIZED, sem retransmitir', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('PROCESS_THEN_DROP').onLookup('NOT_YET_VISIBLE');
    await processor.process(companyId, invoice.id, WORKER);
    advance(2 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toMatchObject({ kind: 'CONSULT_AGAIN', lookup: 'NOT_FOUND' });
    advance(5 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toEqual({ kind: 'AUTHORIZED' });
    expect(gateway.submits).toBe(1);
  });

  it('inexistência provada duas vezes → retransmite o MESMO XML, byte a byte', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('DROP_BEFORE_PROCESSING');
    await processor.process(companyId, invoice.id, WORKER);
    advance(2 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toMatchObject({ kind: 'CONSULT_AGAIN', lookup: 'NOT_FOUND' });
    // "Não encontrado" cedo demais não conta como segunda prova.
    advance(1 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toMatchObject({ kind: 'CONSULT_AGAIN', lookup: 'NOT_FOUND' });
    expect((await state(invoice.id)).status).toBe('UNKNOWN');
    advance(4 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toEqual({ kind: 'RETRANSMISSION_SCHEDULED' });
    expect(await state(invoice.id)).toMatchObject({ status: 'PENDING' });
    expect((await jobs(invoice.id, 'nfse.process')).map((j) => j.singleton_key)).toContain(`${invoice.id}:retransmit:1`);

    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'AUTHORIZED' });
    const s = await state(invoice.id);
    expect(s.attempts.map((a) => a.outcome)).toEqual(['UNKNOWN', 'AUTHORIZED']);
    expect(new Set(s.attempts.map((a) => a.payload_sha256)).size).toBe(1);
    expect(s.signed_dps_sha256).toBe(s.attempts[0]?.payload_sha256);
    expect(preparer.calls).toBe(1);
    expect(gateway.received.get(invoice.dpsId)).toBe(1);
  });

  it('retransmissão que encontra a DPS já recebida (duplicidade) → consulta imediata → AUTHORIZED', async () => {
    const { invoice } = await accept();
    // Recebeu e autorizou, mas as duas consultas "não viram" (caso extremo).
    gateway.onSubmit('PROCESS_THEN_DROP').onLookup('NOT_YET_VISIBLE', 'NOT_YET_VISIBLE');
    await processor.process(companyId, invoice.id, WORKER);
    advance(2 * MIN);
    await reconciler.reconcile(companyId, invoice.id, WORKER);
    advance(5 * MIN);
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toEqual({ kind: 'RETRANSMISSION_SCHEDULED' });
    expect(await processor.process(companyId, invoice.id, WORKER)).toEqual({ kind: 'TRANSMITTED', outcome: 'ALREADY_EXISTS' });
    expect(await reconciler.reconcile(companyId, invoice.id, WORKER)).toEqual({ kind: 'AUTHORIZED' });
    const s = await state(invoice.id);
    expect(s.attempts.map((a) => a.outcome)).toEqual(['UNKNOWN', 'ALREADY_EXISTS']);
    // Uma única NFS-e existe no autorizador.
    expect(s.status).toBe('AUTHORIZED');
  });

  it('autorizador fora do ar por horas: UNKNOWN preservado, consultas com backoff, nunca FAILED', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('DROP_BEFORE_PROCESSING').onLookup('ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR');
    await processor.process(companyId, invoice.id, WORKER);
    advance(2 * MIN);
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const result = await reconciler.reconcile(companyId, invoice.id, WORKER);
      if (result.kind !== 'CONSULT_AGAIN') throw new Error(`esperava nova consulta, veio ${result.kind}`);
      waits.push((result.at.getTime() - clock.getTime()) / MIN);
      clock = result.at;
    }
    expect(waits).toEqual([1, 2, 5, 10, 30, 60, 60]);
    expect(await state(invoice.id)).toMatchObject({ status: 'UNKNOWN', events: ['UNKNOWN'] });
    expect((await jobs(invoice.id, 'nfse.reconcile')).length).toBe(8);
  });
});

describe('travas no banco', () => {
  it('UNKNOWN → FAILED e FAILED depois de envio são recusados pelo trigger, mesmo fora da aplicação', async () => {
    const { invoice } = await accept();
    gateway.onSubmit('PROCESS_THEN_DROP');
    await processor.process(companyId, invoice.id, WORKER);
    await expect(
      new CompanyTransactions(worker.db).run(companyId, (tx) => tx.execute(sql`update service_invoices set status = 'FAILED' where id = ${invoice.id}`)),
    ).rejects.toThrow();
    await expect(
      new CompanyTransactions(worker.db).run(companyId, (tx) => tx.execute(sql`update service_invoices set signed_dps = 'x' where id = ${invoice.id}`)),
    ).rejects.toThrow();
  });

  it('a API não muda estado nem apaga; ninguém apaga tentativas', async () => {
    const { invoice } = await accept();
    await expect(
      new CompanyTransactions(t.api.db).run(companyId, (tx) => tx.execute(sql`update service_invoices set status = 'PROCESSING' where id = ${invoice.id}`)),
    ).rejects.toThrow();
    await expect(new CompanyTransactions(t.api.db).run(companyId, (tx) => tx.execute(sql`delete from service_invoices where id = ${invoice.id}`))).rejects.toThrow();
    await expect(t.adminDb.db.execute(sql`delete from service_invoice_attempts where id = ${newId()}`)).rejects.toThrow();
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condição não atingida');
}
