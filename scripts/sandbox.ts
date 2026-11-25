// Sandbox local: prepara e exercita o motor de ponta a ponta, pela API HTTP, com o autorizador
// SIMULADO (NFSE_GATEWAY=simulator). Só desenvolvimento: nada sai para órgão nenhum.
//
//   npm run sandbox -- init               credencial de teste + e-CNPJ A1 FICTÍCIO (antes de subir o worker-fiscal)
//   npm run sandbox -- setup              empresa, estabelecimento, série e certificado, pela API
//   npm run sandbox -- emit [--dps arquivo.json] [--wait 10]
//   npm run sandbox -- get <id>
//   npm run sandbox -- cancel <id> [--reason-code 1] [--reason-text "..."]
//   npm run sandbox -- status
//
// O estado (ids, a API key de TESTE e a senha do PFX fictício) fica em secrets/sandbox.json, com
// permissão 0600 e fora do git. Nada disso é impresso: a chave nunca vai para o terminal nem para log.
// Os valores da DPS padrão são FICTÍCIOS (test/support/dps-fixtures.ts): servem para exercitar o
// fluxo e o leiaute, não são enquadramento de ninguém. Para testar os seus, use --dps.
import { randomBytes, randomUUID } from 'node:crypto';
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
}

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
    default: throw new SandboxError('uso: sandbox <init|setup|emit|get|cancel|status> (veja o cabeçalho de scripts/sandbox.ts)');
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Nunca a mensagem bruta de erros inesperados: pode conter dados do banco ou da requisição.
  process.stderr.write(error instanceof SandboxError ? `${error.message}\n` : `falha inesperada (${error instanceof Error ? error.name : 'erro'})\n`);
  process.exitCode = 1;
});
