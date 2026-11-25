// Sandbox local: prepara e exercita o motor de ponta a ponta, pela API HTTP, com o autorizador
// SIMULADO (NFSE_GATEWAY=simulator). Só desenvolvimento: nada sai para órgão nenhum.
//
//   npm run sandbox -- init               credencial de teste + e-CNPJ A1 FICTÍCIO (antes de subir o worker-fiscal)
//   npm run sandbox -- setup              empresa, estabelecimento, série e certificado, pela API
//   npm run sandbox -- emit [--dps arquivo.json] [--wait 10]
//   npm run sandbox -- get <id>
//   npm run sandbox -- cancel <id> [--reason-code 1] [--reason-text "..."]
//   npm run sandbox -- status
//   npm run sandbox -- smoke              roteiro automático de ponta a ponta, com webhook recebido e assinatura conferida
//
// O estado (ids, a API key de TESTE e a senha do PFX fictício) fica em secrets/sandbox.json, com
// permissão 0600 e fora do git. Nada disso é impresso: a chave nunca vai para o terminal nem para log.
// Os valores da DPS padrão são FICTÍCIOS (test/support/dps-fixtures.ts): servem para exercitar o
// fluxo e o leiaute, não são enquadramento de ninguém. Para testar os seus, use --dps.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { composeIamAdmin } from '../src/main/compose.js';
import { loadPepperFile, type Scope } from '../src/modules/iam/public.js';
import type { AuditContext } from '../src/shared/application/audit.js';
import { computeCnpjCheckDigits } from '../src/shared/domain/cnpj.js';
import { createDatabase } from '../src/shared/infrastructure/database/database.js';
import { sampleDpsData } from '../test/support/dps-fixtures.js';
import { createTestIcpPki } from '../test/support/icp-test-pki.js';

const STATE_FILE = 'secrets/sandbox.json';
const PFX_FILE = 'secrets/sandbox-certificate.pfx';
const TRUST_BUNDLE_FILE = process.env['CERTIFICATE_TRUST_BUNDLE_FILE'] ?? 'secrets/trust-bundle.pem';
const OUT_DIR = '.local/sandbox';
const MUNICIPALITY = '2211001';

/** Tudo o que o roteiro usa, e nada de produção (`production:*` fica de fora). */
const SCOPES: readonly Scope[] = [
  'companies:create', 'companies:manage', 'fiscal-settings:manage', 'certificates:manage',
  'nfse:issue', 'nfse:read', 'nfse:cancel', 'nfse:debug', 'webhooks:manage',
];

interface SandboxState {
  readonly appId: string;
  readonly apiKey: string;
  readonly rootCnpj: string;
  readonly certificatePassword: string;
  companyId?: string;
  establishmentId?: string;
  certificateId?: string;
  lastInvoiceId?: string;
  /** Assinatura de webhook do smoke (segredo de TESTE, só neste arquivo 0600). */
  webhookSubscriptionId?: string;
  webhookSecret?: string;
}

/** Receptor local dos webhooks do smoke (WEBHOOK_ALLOW_PRIVATE_TARGETS=true, só desenvolvimento). */
const WEBHOOK_PORT = Number(process.env['SANDBOX_WEBHOOK_PORT'] ?? '3199');
const WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}/webhooks/orbita-nfe`;

class SandboxError extends Error {}

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function refuseProduction(): void {
  if (process.env['NODE_ENV'] === 'production') throw new SandboxError('o sandbox não roda com NODE_ENV=production');
}

/** Só a API desta máquina: o sandbox nunca manda a credencial para outro host. */
function apiBase(): string {
  const raw = process.env['SANDBOX_API_URL'] ?? `http://127.0.0.1:${process.env['HTTP_PORT'] ?? '3000'}`;
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new SandboxError(`SANDBOX_API_URL deve apontar para esta máquina (127.0.0.1, localhost ou [::1]), não para ${url.hostname}`);
  return url.origin;
}

function loadState(): SandboxState {
  if (!existsSync(STATE_FILE)) throw new SandboxError(`${STATE_FILE} não existe: rode "npm run sandbox -- init" primeiro`);
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SandboxState;
}

function saveState(state: SandboxState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function randomRoot(): string {
  return String(randomBytes(4).readUInt32BE() % 1e8).padStart(8, '0');
}

function cnpjOf(root: string, branch = '0001'): string {
  const base = root + branch;
  return base + computeCnpjCheckDigits(base);
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

async function call(state: SandboxState, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${state.apiKey}`, ...options.headers };
  if (state.companyId !== undefined) headers['x-company-id'] = state.companyId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  } catch {
    throw new SandboxError(`a API não respondeu em ${apiBase()}: suba com "npm run dev:api"`);
  }
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(text);
  return { status: res.status, body, text };
}

function expectStatus(res: ApiResponse, expected: readonly number[], what: string): Record<string, unknown> {
  if (!expected.includes(res.status)) {
    const problem = res.body as { code?: string; detail?: string; issues?: { field?: string; code?: string; message?: string }[] };
    const issues = (problem.issues ?? []).map((i) => `\n  - ${i.field ?? ''} ${i.code ?? ''}: ${i.message ?? ''}`).join('');
    throw new SandboxError(`${what}: HTTP ${res.status} ${problem.code ?? ''} ${problem.detail ?? ''}${issues}`);
  }
  return res.body as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function init(force: boolean): Promise<void> {
  if (existsSync(STATE_FILE) && !force) throw new SandboxError(`${STATE_FILE} já existe. Use --force para começar de novo (uma empresa nova será criada no setup)`);
  const adminUrl = process.env['ADMIN_DATABASE_URL'];
  const pepperFile = process.env['API_KEY_PEPPER_FILE'];
  if (adminUrl === undefined || pepperFile === undefined) throw new SandboxError('defina ADMIN_DATABASE_URL e API_KEY_PEPPER_FILE (.env, veja .env.example)');
  mkdirSync('secrets', { recursive: true });

  const rootCnpj = randomRoot();
  const certificatePassword = randomBytes(18).toString('base64url');
  const pki = createTestIcpPki();
  writeFileSync(PFX_FILE, pki.pfx({ cnpj: cnpjOf(rootCnpj), password: certificatePassword }), { mode: 0o600 });
  writeFileSync(TRUST_BUNDLE_FILE, pki.trustBundlePem);

  const context: AuditContext = { actor: { kind: 'OPERATOR', operator: 'sandbox-local' }, correlationId: null };
  const database = createDatabase({ url: adminUrl, poolMax: 1, statementTimeoutMs: 10_000, applicationName: 'orbita-nfe-sandbox' });
  try {
    const admin = composeIamAdmin({ db: database.db, apiKeyPepper: loadPepperFile(pepperFile) });
    const appId = await admin.createClientApplication(`Sandbox local ${new Date().toISOString()}`, context);
    const issued = await admin.issueCredential({ clientApplicationId: appId, environment: 'test', scopes: [...SCOPES] }, context);
    saveState({ appId, apiKey: issued.token, rootCnpj, certificatePassword });
  } finally {
    await database.close();
  }
  out(`credencial de TESTE criada (escopos: ${SCOPES.join(', ')}) e guardada em ${STATE_FILE}`);
  out(`e-CNPJ A1 FICTÍCIO para ${cnpjOf(rootCnpj)} em ${PFX_FILE}; ACs de teste em ${TRUST_BUNDLE_FILE}`);
  out('Agora (re)inicie o worker-fiscal, para ele ler as ACs de teste, e rode "npm run sandbox -- setup".');
}

async function setup(): Promise<void> {
  const state = loadState();
  const health = await fetch(`${apiBase()}/health/ready`).catch(() => undefined);
  if (health?.ok !== true) throw new SandboxError(`a API não está pronta em ${apiBase()}: suba com "npm run dev:api"`);

  if (state.companyId === undefined) {
    const company = expectStatus(await call(state, 'POST', '/v1/companies', { body: { legalName: 'EMPRESA FICTICIA SANDBOX LTDA', rootCnpj: state.rootCnpj } }), [201], 'empresa');
    state.companyId = company['id'] as string;
    saveState(state);
  }
  out(`empresa ${state.companyId} (raiz ${state.rootCnpj})`);

  if (state.establishmentId === undefined) {
    const est = expectStatus(await call(state, 'POST', '/v1/establishments', { body: { cnpj: cnpjOf(state.rootCnpj), tradeName: 'Matriz sandbox', municipalityCode: MUNICIPALITY } }), [201], 'estabelecimento');
    state.establishmentId = est['id'] as string;
    saveState(state);
    expectStatus(await call(state, 'POST', `/v1/establishments/${state.establishmentId}/document-series`, { body: { kind: 'NFSE_DPS', environment: 'HOMOLOGATION', series: '1' } }), [201], 'série de DPS');
  }
  out(`estabelecimento ${state.establishmentId} (${cnpjOf(state.rootCnpj)}), série 1 de DPS em homologação`);

  if (state.certificateId === undefined) {
    const pfx = readFileSync(PFX_FILE).toString('base64');
    const cert = expectStatus(await call(state, 'POST', `/v1/establishments/${state.establishmentId}/certificates`, { body: { pfx, password: state.certificatePassword } }), [202], 'certificado');
    state.certificateId = cert['id'] as string;
    saveState(state);
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    const list = expectStatus(await call(state, 'GET', `/v1/establishments/${state.establishmentId}/certificates`), [200], 'certificados');
    const cert = (list['items'] as { id: string; status: string }[]).find((c) => c.id === state.certificateId);
    if (cert !== undefined && cert.status !== 'PENDING_VALIDATION') {
      if (cert.status !== 'ACTIVE') throw new SandboxError(`certificado ${cert.status}: o worker-fiscal leu outras ACs? Reinicie-o depois do init`);
      out(`certificado ${state.certificateId} ACTIVE`);
      break;
    }
    if (Date.now() > deadline) throw new SandboxError('o certificado segue PENDING_VALIDATION depois de 60 s: o worker-fiscal está rodando? ("npm run dev:worker-fiscal")');
    await sleep(1000);
  }
  out('Pronto. Emita com "npm run sandbox -- emit".');
}

/** Texto de um campo do JSON: string e número como são, o resto em JSON. */
const show = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value));

function describeInvoice(invoice: Record<string, unknown>): void {
  out(`nota ${String(invoice['id'])}: ${String(invoice['status'])} (número ${show(invoice['number'] ?? '-')}, ambiente ${String(invoice['environment'])})`);
  if (invoice['accessKey'] != null) out(`  chave de acesso: ${show(invoice['accessKey'])}`);
  if (invoice['authorizerStatus'] != null) out(`  autorizador: ${JSON.stringify(invoice['authorizerStatus'])}`);
  if (invoice['rejection'] != null) out(`  rejeição: ${JSON.stringify(invoice['rejection'])}`);
  if (invoice['failureCode'] != null) out(`  falha local: ${show(invoice['failureCode'])}`);
  const links = invoice['links'] as Record<string, string | null> | undefined;
  if (links !== undefined) out(`  links: ${Object.entries(links).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
}

async function saveXml(state: SandboxState, invoice: Record<string, unknown>): Promise<void> {
  const links = invoice['links'] as Record<string, string | null> | undefined;
  const id = String(invoice['id']);
  for (const [name, path] of [['nfse', links?.['xml']], ['cancelamento', links?.['cancellationXml']]] as const) {
    if (path == null) continue;
    const res = await call(state, 'GET', path);
    if (res.status !== 200) continue;
    mkdirSync(OUT_DIR, { recursive: true });
    const file = `${OUT_DIR}/${id}-${name}.xml`;
    writeFileSync(file, res.text);
    out(`  XML (${name}) salvo em ${file}`);
  }
  const danfse = links?.['danfse'];
  if (danfse == null) return;
  // O DANFSe é binário: lido como bytes, não como texto.
  const headers: Record<string, string> = { authorization: `Bearer ${state.apiKey}` };
  if (state.companyId !== undefined) headers['x-company-id'] = state.companyId;
  const res = await fetch(`${apiBase()}${danfse}`, { headers });
  if (res.status !== 200) {
    out(`  DANFSe: HTTP ${res.status}`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${id}-danfse.pdf`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  out(`  DANFSe salvo em ${file}`);
}

async function emit(dpsFile: string | undefined, wait: number): Promise<void> {
  const state = loadState();
  if (state.establishmentId === undefined) throw new SandboxError('rode "npm run sandbox -- setup" primeiro');
  const dps = dpsFile === undefined ? sampleDpsData({ competenceDate: new Date().toISOString().slice(0, 10) }) : (JSON.parse(readFileSync(dpsFile, 'utf8')) as Record<string, unknown>);
  if (dpsFile === undefined) out('DPS com valores FICTÍCIOS (só exercitam o fluxo; para os seus, use --dps arquivo.json)');
  const body = { externalReference: `sandbox-${Date.now()}`, ...dps, establishmentId: state.establishmentId };
  const res = await call(state, 'POST', '/v1/service-invoices', { body, headers: { 'idempotency-key': randomUUID(), prefer: `wait=${wait}` } });
  const invoice = expectStatus(res, [200, 201, 202], 'emissão');
  state.lastInvoiceId = String(invoice['id']);
  saveState(state);
  out(`HTTP ${res.status}${res.status === 202 ? ' (ainda em andamento: consulte com "npm run sandbox -- get <id>")' : ''}`);
  describeInvoice(invoice);
  await saveXml(state, invoice);
}

async function get(id: string | undefined): Promise<void> {
  const state = loadState();
  const invoiceId = id ?? state.lastInvoiceId;
  if (invoiceId === undefined) throw new SandboxError('informe o id da nota');
  const invoice = expectStatus(await call(state, 'GET', `/v1/service-invoices/${invoiceId}`), [200], 'consulta');
  describeInvoice(invoice);
  await saveXml(state, invoice);
}

async function cancel(id: string | undefined, reasonCode: string, reasonText: string): Promise<void> {
  const state = loadState();
  const invoiceId = id ?? state.lastInvoiceId;
  if (invoiceId === undefined) throw new SandboxError('informe o id da nota');
  const res = await call(state, 'POST', `/v1/service-invoices/${invoiceId}/cancellation`, { body: { reasonCode, reasonText }, headers: { prefer: 'wait=10' } });
  const cancellation = expectStatus(res, [200, 201, 202], 'cancelamento');
  out(`HTTP ${res.status}: pedido de cancelamento ${String(cancellation['status'])}`);
  await get(invoiceId);
}

function status(): void {
  const state = loadState();
  out(`aplicação ${state.appId}; empresa ${state.companyId ?? '(setup pendente)'}; estabelecimento ${state.establishmentId ?? '-'} (${cnpjOf(state.rootCnpj)}); certificado ${state.certificateId ?? '-'}; última nota ${state.lastInvoiceId ?? '-'}`);
  out(`API: ${apiBase()} (documentação em ${apiBase()}/docs/)`);
}

interface ReceivedWebhook {
  readonly id: string;
  readonly type: string;
  readonly subjectId: string;
  readonly status: string | undefined;
  readonly signatureValid: boolean;
}

/** Confere a assinatura Standard Webhooks como o guia manda (docs/api/webhooks.md). */
function webhookSignatureValid(secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string): boolean {
  const id = String(headers['webhook-id'] ?? '');
  const timestamp = String(headers['webhook-timestamp'] ?? '');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
  return String(headers['webhook-signature'] ?? '')
    .split(' ')
    .some((candidate) => candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)));
}

function startWebhookReceiver(secret: string, received: ReceivedWebhook[]): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const body = JSON.parse(raw) as { type?: string; subject?: { id?: string }; data?: { status?: string } };
        received.push({
          id: String(req.headers['webhook-id'] ?? ''),
          type: body.type ?? '',
          subjectId: body.subject?.id ?? '',
          status: body.data?.status,
          signatureValid: webhookSignatureValid(secret, req.headers, raw),
        });
      } catch {
        // corpo ilegível: não conta como recebido
      }
      res.writeHead(204).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(WEBHOOK_PORT, '127.0.0.1', () => { resolve(server); });
  });
}

async function waitFor<T>(what: string, seconds: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new SandboxError(`${what}: nada em ${seconds} s`);
    await sleep(500);
  }
}

/**
 * Roteiro automático de ponta a ponta contra a API, o worker-fiscal e o worker-general locais.
 * Cada passo confere o resultado; o primeiro que falhar encerra com código 1.
 */
async function smoke(): Promise<void> {
  const state = loadState();
  if (state.establishmentId === undefined) throw new SandboxError('rode "npm run sandbox -- setup" primeiro');
  const passed: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      out(`✗ ${name}`);
      throw error instanceof SandboxError ? error : new SandboxError(`${name}: falha inesperada`);
    }
    passed.push(name);
    out(`✓ ${name}`);
  };
  const check = (ok: boolean, message: string): void => {
    if (!ok) throw new SandboxError(message);
  };

  // Webhook: assinatura criada uma vez e reaproveitada (o segredo só aparece na criação).
  if (state.webhookSubscriptionId === undefined || state.webhookSecret === undefined) {
    const created = expectStatus(
      await call(state, 'POST', '/v1/webhook-subscriptions', { body: { url: WEBHOOK_URL, eventTypes: ['service_invoice.status_changed', 'service_invoice.cancellation_changed'] } }),
      [201],
      'assinatura de webhook',
    );
    state.webhookSubscriptionId = String(created['id']);
    state.webhookSecret = String(created['secret']);
    saveState(state);
  }
  const received: ReceivedWebhook[] = [];
  const server = await startWebhookReceiver(state.webhookSecret, received).catch(() => {
    throw new SandboxError(`porta ${String(WEBHOOK_PORT)} ocupada: defina SANDBOX_WEBHOOK_PORT`);
  });

  try {
    const dps = sampleDpsData({ competenceDate: new Date().toISOString().slice(0, 10) });
    const reference = `smoke-${Date.now()}`;
    const body = { externalReference: reference, ...dps, establishmentId: state.establishmentId };
    const key = randomUUID();
    let invoiceId = '';
    let invoice: Record<string, unknown> = {};

    await step('validação sem efeitos (POST /validation) → 200', async () => {
      const res = await call(state, 'POST', '/v1/service-invoices/validation', { body: { ...dps, establishmentId: state.establishmentId } });
      expectStatus(res, [200], 'validação');
    });

    await step('regra do Anexo I antes de numerar: município inexistente → 422 E0302', async () => {
      const res = await call(state, 'POST', '/v1/service-invoices', {
        body: { ...body, externalReference: `${reference}-invalida`, service: { ...dps.service, municipalityCode: '9999999' } },
        headers: { 'idempotency-key': randomUUID() },
      });
      const problem = res.body as { code?: string; issues?: { code?: string }[] };
      check(res.status === 422 && problem.code === 'NFSE_RULES_VIOLATED' && (problem.issues ?? []).some((i) => i.code === 'E0302'), `esperado 422 E0302, veio HTTP ${String(res.status)}`);
    });

    await step('emissão com Prefer: wait → 201 AUTHORIZED com chave de acesso e cStat 100', async () => {
      const res = await call(state, 'POST', '/v1/service-invoices', { body, headers: { 'idempotency-key': key, prefer: 'wait=15' } });
      invoice = expectStatus(res, [201], 'emissão');
      invoiceId = String(invoice['id']);
      state.lastInvoiceId = invoiceId;
      saveState(state);
      const status = invoice['authorizerStatus'] as { code?: string } | null;
      check(invoice['status'] === 'AUTHORIZED' && typeof invoice['accessKey'] === 'string' && status?.code === '100', `nota ${String(invoice['status'])}`);
    });

    await step('repetição com a mesma Idempotency-Key → 200, a mesma nota (nenhuma emissão nova)', async () => {
      const again = expectStatus(await call(state, 'POST', '/v1/service-invoices', { body, headers: { 'idempotency-key': key } }), [200], 'repetição');
      check(again['id'] === invoiceId, 'a repetição devolveu outra nota');
    });

    await step('mesma Idempotency-Key com outro corpo → 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const res = await call(state, 'POST', '/v1/service-invoices', { body: { ...body, externalReference: `${reference}-outra` }, headers: { 'idempotency-key': key } });
      check(res.status === 422 && (res.body as { code?: string }).code === 'IDEMPOTENCY_KEY_REUSED', `esperado 422 IDEMPOTENCY_KEY_REUSED, veio HTTP ${String(res.status)}`);
    });

    await step('consulta pela referência externa → a nota emitida', async () => {
      const list = expectStatus(await call(state, 'GET', `/v1/service-invoices?externalReference=${encodeURIComponent(reference)}`), [200], 'consulta por referência');
      check((list['items'] as { id: string }[]).some((i) => i.id === invoiceId), 'a nota não apareceu na consulta');
    });

    await step('XML autorizado com ETag igual ao SHA-256 dos bytes', async () => {
      const res = await call(state, 'GET', `/v1/service-invoices/${invoiceId}/xml`);
      check(res.status === 200, `HTTP ${String(res.status)}`);
      const headers = await fetch(`${apiBase()}/v1/service-invoices/${invoiceId}/xml`, { headers: authHeaders(state) });
      check(headers.headers.get('etag') === `"${createHash('sha256').update(res.text, 'utf8').digest('hex')}"`, 'ETag não confere');
    });

    await step('DANFSe em PDF (NT 008)', async () => {
      const res = await fetch(`${apiBase()}/v1/service-invoices/${invoiceId}/danfse`, { headers: authHeaders(state) });
      const pdf = Buffer.from(await res.arrayBuffer());
      check(res.status === 200 && pdf.subarray(0, 5).toString('latin1') === '%PDF-', `HTTP ${String(res.status)}`);
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(`${OUT_DIR}/${invoiceId}-danfse.pdf`, pdf);
    });

    await step('diagnóstico com a tentativa de envio (nfse:debug)', async () => {
      const diag = expectStatus(await call(state, 'GET', `/v1/service-invoices/${invoiceId}/diagnostics`), [200], 'diagnóstico');
      check(Array.isArray(diag['attempts']) && (diag['attempts'] as unknown[]).length >= 1, 'sem tentativas');
    });

    await step('webhook service_invoice.status_changed AUTHORIZED recebido, com assinatura válida', async () => {
      const hook = await waitFor('webhook da autorização', 30, () => received.find((w) => w.subjectId === invoiceId && w.status === 'AUTHORIZED'));
      check(hook.signatureValid, 'assinatura do webhook inválida');
    });

    await step('cancelamento com Prefer: wait → REGISTERED; a nota vira CANCELLED', async () => {
      const res = await call(state, 'POST', `/v1/service-invoices/${invoiceId}/cancellation`, {
        body: { reasonCode: '1', reasonText: 'Cancelamento do teste de fumaça do sandbox' },
        headers: { prefer: 'wait=15' },
      });
      const cancellation = expectStatus(res, [201], 'cancelamento');
      check(cancellation['status'] === 'REGISTERED', `pedido ${String(cancellation['status'])}`);
      const after = expectStatus(await call(state, 'GET', `/v1/service-invoices/${invoiceId}`), [200], 'consulta');
      check(after['status'] === 'CANCELLED', `nota ${String(after['status'])}`);
      check((await call(state, 'GET', `/v1/service-invoices/${invoiceId}/cancellation/xml`)).status === 200, 'XML do cancelamento indisponível');
    });

    await step('webhook do cancelamento recebido, com assinatura válida', async () => {
      const hook = await waitFor('webhook do cancelamento', 30, () => received.find((w) => w.subjectId === invoiceId && w.type === 'service_invoice.cancellation_changed'));
      check(hook.signatureValid, 'assinatura do webhook inválida');
    });

    await step('reenvio do aviso pela nota (ADR-0056) chega de novo com o mesmo webhook-id', async () => {
      const before = received.filter((w) => w.subjectId === invoiceId).length;
      expectStatus(await call(state, 'POST', '/v1/webhook-deliveries/redeliveries', { body: { subjectId: invoiceId } }), [202], 'reenvio');
      await waitFor('webhook reenviado', 30, () => (received.filter((w) => w.subjectId === invoiceId).length > before ? true : undefined));
      const ids = received.filter((w) => w.subjectId === invoiceId).map((w) => w.id);
      check(new Set(ids).size < ids.length, 'o reenvio não repetiu o webhook-id');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  }
  out(`\n${String(passed.length)} passos conferidos. Nada foi enviado a órgão nenhum (autorizador simulado).`);
}

function authHeaders(state: SandboxState): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${state.apiKey}` };
  if (state.companyId !== undefined) headers['x-company-id'] = state.companyId;
  return headers;
}

async function main(argv: string[]): Promise<void> {
  refuseProduction();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      dps: { type: 'string' },
      wait: { type: 'string' },
      'reason-code': { type: 'string' },
      'reason-text': { type: 'string' },
    },
    strict: true,
  });
  const [command, arg] = positionals;
  switch (command) {
    case 'init': return init(values.force === true);
    case 'setup': return setup();
    case 'emit': {
      const wait = Number(values.wait ?? '10');
      if (!Number.isInteger(wait) || wait < 0 || wait > 20) throw new SandboxError('--wait vai de 0 a 20 segundos');
      return emit(values.dps, wait);
    }
    case 'get': return get(arg);
    case 'cancel': return cancel(arg, values['reason-code'] ?? '1', values['reason-text'] ?? 'Cancelamento de teste no sandbox local');
    case 'status':
      status();
      return;
    case 'smoke': return smoke();
    default: throw new SandboxError('uso: sandbox <init|setup|emit|get|cancel|status|smoke> (veja o cabeçalho de scripts/sandbox.ts)');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Nunca a mensagem bruta de erros inesperados: pode conter dados do banco ou da requisição.
  process.stderr.write(error instanceof SandboxError ? `${error.message}\n` : `falha inesperada (${error instanceof Error ? error.name : 'erro'})\n`);
  process.exitCode = 1;
});
