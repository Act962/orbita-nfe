import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyTransactions } from '../../src/shared/infrastructure/database/database.js';
import { connect, newId } from './support/db.js';
import { bearer, cnpjOf, createClientApp, createCompany, createEstablishment, startTestApi, type TestApi } from './support/api.js';
import type { DatabaseHandle } from '../../src/shared/infrastructure/database/database.js';

/**
 * Travas de banco da NFC-e (ADR-0072, migration 0039): as mesmas garantias da NFS-e valem mesmo
 * fora da aplicação. Dados FICTÍCIOS; nada é transmitido.
 */
let t: TestApi;
let worker: DatabaseHandle;
let companyId: string;
let otherCompanyId: string;
let establishmentId: string;
let seriesId: string;
let appId: string;
let nextNumber = 1;

const KEY = '22261111222333000181650010000000011000000019';
const DIGEST = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Constraint violada, ou o SQLSTATE: o erro do Postgres pode vir embrulhado mais de uma vez (`cause`). */
async function violation(run: Promise<unknown>): Promise<string | undefined> {
  return run.then(
    () => 'aceitou',
    (error: unknown) => {
      let current: unknown = error;
      for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
        const e = current as { constraint?: string; code?: string; cause?: unknown };
        if (typeof e.constraint === 'string') return e.constraint;
        if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
        current = e.cause;
      }
      return `não reconhecido: ${String(error)}`;
    },
  );
}

async function insertInvoice(asCompany = companyId): Promise<string> {
  const id = newId();
  const number = nextNumber++;
  await new CompanyTransactions(t.api.db).run(asCompany, (tx) =>
    tx.execute(sql`insert into consumer_invoices (id, company_id, establishment_id, client_application_id, environment, series_id, series, number,
      numeric_code, idempotency_key, request_hash, payload)
      values (${id}, ${asCompany}, ${establishmentId}, ${appId}, 'HOMOLOGATION', ${seriesId}, '1', ${number}, '48213957', ${`chave-${id}`}, ${'0'.repeat(64)}, '{}'::jsonb)`),
  );
  return id;
}

type Tx = Parameters<Parameters<CompanyTransactions['run']>[1]>[0];

/**
 * Transação crua no contexto da empresa: o `CompanyTransactions` da aplicação transforma erros de
 * permissão em "erro interno" (não vaza detalhe na API); aqui o teste precisa do SQLSTATE real.
 */
function inCompany(db: DatabaseHandle, asCompany: string, run: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  return db.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${asCompany}, true)`);
    return run(tx);
  });
}

const asWorker = (run: (tx: Tx) => Promise<unknown>) => inCompany(worker, companyId, run);

async function insertAttempt(invoiceId: string, seq: number): Promise<string> {
  const id = newId();
  await asWorker((tx) =>
    tx.execute(sql`insert into consumer_invoice_attempts (id, company_id, invoice_id, seq, access_key, issued_at, signed_xml, payload_sha256, digest_value)
      values (${id}, ${companyId}, ${invoiceId}, ${seq}, ${KEY}, now(), '<NFe/>', ${'1'.repeat(64)}, ${DIGEST})`),
  );
  return id;
}

const setStatus = (invoiceId: string, status: string, extra = sql``) => asWorker((tx) => tx.execute(sql`update consumer_invoices set status = ${status} ${extra} where id = ${invoiceId}`));

beforeAll(async () => {
  t = await startTestApi();
  worker = connect('worker');
  const app = await createClientApp(t.admin, 'nfce');
  appId = app.id;
  const key = await app.key(['companies:create', 'companies:manage', 'fiscal-settings:manage']);
  const company = await createCompany(t.app, key);
  companyId = company.id;
  otherCompanyId = (await createCompany(t.app, key)).id;
  establishmentId = await createEstablishment(t.app, key, companyId, cnpjOf(company.root));
  const series = await t.app.inject({
    method: 'POST',
    url: `/v1/establishments/${establishmentId}/document-series`,
    headers: bearer(key, companyId),
    payload: { kind: 'NFCE', environment: 'HOMOLOGATION', series: '1' },
  });
  seriesId = series.json<{ id: string }>().id;
});

afterAll(async () => {
  await worker.close();
  await t.close();
});

describe('consumer_invoices: máquina de estados no banco', () => {
  it('segue as transições do domínio e recusa as outras', async () => {
    const id = await insertInvoice();
    expect(await violation(setStatus(id, 'AUTHORIZED'))).toBe('ck_consumer_invoices_transition');
    await setStatus(id, 'PROCESSING');
    await setStatus(id, 'UNKNOWN');
    expect(await violation(setStatus(id, 'REJECTED'))).toBe('ck_consumer_invoices_transition');
    await setStatus(id, 'PENDING');
  });

  it('autorizada exige chave, cStat, protocolo e nfeProc; depois, nada muda', async () => {
    const id = await insertInvoice();
    await setStatus(id, 'PROCESSING');
    // Sem chave nem protocolo, as duas constraints falham; o Postgres acusa uma delas.
    expect(await violation(setStatus(id, 'AUTHORIZED'))).toMatch(/^ck_consumer_invoices_(settled|authorized)$/);
    expect(await violation(setStatus(id, 'AUTHORIZED', sql`, protocol_number = '1', nfe_proc_xml = '<x/>', nfe_proc_xml_sha256 = ${'2'.repeat(64)}`))).toBe('ck_consumer_invoices_settled');
    await setStatus(
      id,
      'AUTHORIZED',
      sql`, access_key = ${KEY}, authorizer_status_code = '100', protocol_number = '122260000000001', nfe_proc_xml = '<nfeProc/>', nfe_proc_xml_sha256 = ${'2'.repeat(64)}`,
    );
    expect(await violation(asWorker((tx) => tx.execute(sql`update consumer_invoices set protocol_number = '1' where id = ${id}`)))).toBe('ck_consumer_invoices_write_once');
    expect(await violation(setStatus(id, 'DENIED'))).toBe('ck_consumer_invoices_transition');
  });

  it('denegada é final e exige chave e cStat', async () => {
    const id = await insertInvoice();
    await setStatus(id, 'PROCESSING');
    await setStatus(id, 'DENIED', sql`, access_key = ${KEY}, authorizer_status_code = '110'`);
    expect(await violation(setStatus(id, 'PENDING'))).toBe('ck_consumer_invoices_transition');
  });

  it('FAILED é proibido depois que uma tentativa chegou a SENDING', async () => {
    const id = await insertInvoice();
    await setStatus(id, 'PROCESSING');
    const attempt = await insertAttempt(id, 1);
    await asWorker((tx) => tx.execute(sql`update consumer_invoice_attempts set state = 'SENDING', sending_at = now() where id = ${attempt}`));
    expect(await violation(setStatus(id, 'FAILED'))).toBe('ck_consumer_invoices_failed_after_send');
  });

  it('identidade e venda imutáveis; nada é apagado', async () => {
    const id = await insertInvoice();
    expect(await violation(asWorker((tx) => tx.execute(sql`update consumer_invoices set status = 'PROCESSING', lease_until = now() where id = ${id}`)))).toBe('aceitou');
    // O superusuário ignora o RLS, mas não os triggers: nem ele muda a venda ou apaga a nota.
    const superuser = connect('superuser');
    expect(await violation(superuser.db.execute(sql`update consumer_invoices set numeric_code = '11111111' where id = ${id}`))).toBe('ck_consumer_invoices_immutable');
    expect(await violation(superuser.db.execute(sql`delete from consumer_invoices where id = ${id}`))).toBe('ck_consumer_invoices_no_delete');
    await superuser.close();
  });
});

describe('consumer_invoice_attempts: write-ahead', () => {
  it('no máximo uma tentativa aberta; XML, chave e digest nunca mudam', async () => {
    const id = await insertInvoice();
    const first = await insertAttempt(id, 1);
    expect(await violation(insertAttempt(id, 2))).toBe('uq_consumer_invoice_attempts_open');
    // Duas barreiras: o worker nem tem permissão na coluna, e o trigger barra até o superusuário.
    expect(await violation(asWorker((tx) => tx.execute(sql`update consumer_invoice_attempts set signed_xml = '<outro/>' where id = ${first}`)))).toBe('42501');
    const superuser = connect('superuser');
    expect(await violation(superuser.db.execute(sql`update consumer_invoice_attempts set digest_value = ${`${'B'.repeat(27)}=`} where id = ${first}`))).toBe('ck_consumer_invoice_attempts_immutable');
    await superuser.close();
    await asWorker((tx) => tx.execute(sql`update consumer_invoice_attempts set state = 'SENDING', sending_at = now() where id = ${first}`));
    expect(
      await violation(asWorker((tx) => tx.execute(sql`update consumer_invoice_attempts set state = 'CLOSED', closed_at = now(), outcome = 'RECOVERED_NOT_SENT' where id = ${first}`))),
    ).toBe('ck_consumer_invoice_attempts_not_sent_after_sending');
    await asWorker((tx) => tx.execute(sql`update consumer_invoice_attempts set state = 'CLOSED', closed_at = now(), outcome = 'NOT_SENT' where id = ${first}`));
    expect(await violation(insertAttempt(id, 2))).toBe('aceitou');
  });
});

describe('permissões e isolamento', () => {
  it('a API aceita mas não muda estado; não lê o XML assinado das tentativas', async () => {
    const id = await insertInvoice();
    await insertAttempt(id, 1);
    const asApi = (run: (tx: Tx) => Promise<unknown>) => inCompany(t.api, companyId, run);
    expect(await violation(asApi((tx) => tx.execute(sql`update consumer_invoices set status = 'PROCESSING' where id = ${id}`)))).toBe('42501');
    expect(await violation(asApi((tx) => tx.execute(sql`select signed_xml from consumer_invoice_attempts where invoice_id = ${id}`)))).toBe('42501');
    expect(await violation(asApi((tx) => tx.execute(sql`select access_key, outcome from consumer_invoice_attempts where invoice_id = ${id}`)))).toBe('aceitou');
  });

  it('RLS: outra empresa não vê nem grava notas desta', async () => {
    const id = await insertInvoice();
    const seen = await new CompanyTransactions(t.api.db).run(otherCompanyId, (tx) => tx.execute(sql`select id from consumer_invoices where id = ${id}`));
    expect(seen.rows).toEqual([]);
    // No contexto da outra empresa, gravar uma nota com o company_id desta viola a política (WITH CHECK).
    const forged = inCompany(t.api, otherCompanyId, (tx) =>
      tx.execute(sql`insert into consumer_invoices (id, company_id, establishment_id, client_application_id, environment, series_id, series, number,
        numeric_code, idempotency_key, request_hash, payload)
        values (${newId()}, ${companyId}, ${establishmentId}, ${appId}, 'HOMOLOGATION', ${seriesId}, '1', 999, '48213957', 'forjada', ${'0'.repeat(64)}, '{}'::jsonb)`),
    );
    expect(await violation(forged)).toBe('42501');
  });
});
