import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { Agent } from 'undici';
import { ForgePkcs12Reader } from '../modules/certificates/public.js';
import { queryProtocol, queryServiceStatus, SVRS_NFCE_PROTOCOL_QUERY, SVRS_NFCE_STATUS } from '../modules/nfce/public.js';
import { createMtlsAgent } from '../shared/infrastructure/transport/mtls-transport.js';
import { loadFiscalSchemas, loadNfceServerTrust } from './fiscal-resources.js';

/**
 * Consultas da NFC-e no SVRS, em HOMOLOGAÇÃO. Nenhuma emite nota.
 *
 *   npm run nfce:test -- status <certificado.p12> [--uf 22]          (ADR-0063)
 *   npm run nfce:test -- consult <certificado.p12> --key <chave 44>  (ADR-0064)
 *
 * - Só homologação (tpAmb = 2); não há URL de produção aqui.
 * - `status --uf`: código IBGE da UF consultada (padrão 22, Piauí). A regra K02 do MOC recusa (cStat
 *   289) a UF que o webservice não atende: um 107 com cUF 22 confirma que o SVRS atende o PI.
 * - `consult --key`: a situação da nota pela chave de acesso (217 = não consta na base da SEFAZ).
 * - A senha é pedida sem eco; certificado e chave só na memória.
 * - Grava em `.local/nfce-teste/` (fora do git) a resposta SOAP e o resumo.
 * - MOC 7.0, item 5.5.3: no mínimo 3 minutos entre consultas de status. O CLI recusa antes disso.
 */
const OUT = join('.local', 'nfce-teste');
const LAST = join(OUT, 'ultima-consulta-status.txt');
const MIN_INTERVAL_MS = 3 * 60 * 1000;
const USAGE =
  'uso: nfce:test status <cert.p12> [--uf <código IBGE da UF, 2 dígitos; padrão 22>]\n' +
  '     nfce:test consult <cert.p12> --key <chave de acesso, 44 posições>\n';

class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message.endsWith('\n') ? message : `${message}\n`);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { uf: { type: 'string', default: '22' }, key: { type: 'string' } } });
const [command, p12Path] = positionals;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

try {
  if ((command !== 'status' && command !== 'consult') || p12Path === undefined) fail(USAGE);
  mkdirSync(OUT, { recursive: true });
  if (command === 'status') await status(p12Path);
  else await consult(p12Path);
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(error.message);
  process.exitCode = 2;
}

async function status(path: string): Promise<void> {
  const uf = values.uf;
  if (!/^[0-9]{2}$/.test(uf)) fail('--uf: código IBGE da UF com 2 dígitos (PI = 22).');
  if (existsSync(LAST)) {
    const elapsed = Date.now() - Date.parse(readFileSync(LAST, 'utf8').trim());
    if (elapsed < MIN_INTERVAL_MS) fail(`Aguarde ${Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000)} s: o MOC pede no mínimo 3 minutos entre consultas de status.`);
  }
  const url = SVRS_NFCE_STATUS.HOMOLOGATION;
  await withAgent(path, url, async (agent) => {
    writeFileSync(LAST, new Date().toISOString());
    const result = await queryServiceStatus({ agent, url, query: { tpAmb: '2', cUF: uf }, catalog: loadFiscalSchemas() });
    save('status', { uf }, result);
    if (result.kind === 'STATUS') {
      // Anexo I, item 4.4.1: 107 Serviço em Operação; 108 paralisado momentaneamente; 109 sem previsão.
      const meaning = { '107': 'serviço em operação', '108': 'paralisado momentaneamente', '109': 'paralisado sem previsão' }[result.status.cStat];
      process.stdout.write(`cStat ${result.status.cStat}: ${result.status.xMotivo}${meaning === undefined ? '' : ` (${meaning})`}\n`);
    }
  });
}

async function consult(path: string): Promise<void> {
  const key = values.key ?? fail(USAGE);
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(key)) fail('--key: chave de acesso com 44 posições (CNPJ pode ser alfanumérico).');
  const url = SVRS_NFCE_PROTOCOL_QUERY.HOMOLOGATION;
  await withAgent(path, url, async (agent) => {
    const result = await queryProtocol({ agent, url, query: { tpAmb: '2', accessKey: key }, catalog: loadFiscalSchemas() });
    save('consulta', { key }, result);
    if (result.kind === 'PROTOCOL') process.stdout.write(`cStat ${result.header.cStat}: ${result.header.xMotivo} → ${result.situation.kind}\n`);
  });
}

async function withAgent(path: string, url: string, run: (agent: Agent) => Promise<void>): Promise<void> {
  process.stdout.write(`Autorizador: SVRS, NFC-e, homologação (${url})\n`);
  const password = await askHidden('Senha do certificado: ');
  const agent = createMtlsAgent(openCertificate(path, password), { connectTimeoutMs: 10_000, headersTimeoutMs: 30_000, bodyTimeoutMs: 30_000, maxResponseBytes: 512 * 1024 });
  try {
    await run(agent);
  } finally {
    await agent.close();
  }
}

/** A resposta SOAP vai inteira para .local/; no terminal e no resumo, só os campos. */
function save(name: string, input: Record<string, unknown>, result: object): void {
  const responseXml = 'responseXml' in result && typeof result.responseXml === 'string' ? result.responseXml : undefined;
  if (responseXml !== undefined) writeFileSync(join(OUT, `${stamp}-resposta-${name}.xml`), responseXml);
  const summary = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'responseXml'));
  if ('situation' in summary && typeof summary.situation === 'object' && summary.situation !== null) {
    summary.situation = Object.fromEntries(Object.entries(summary.situation as Record<string, unknown>).filter(([key]) => !key.endsWith('Xml')));
  }
  report(name, { ...input, ...summary });
}

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as ReturnType<typeof createInterface> & {
      _writeToOutput: (text: string) => void;
    };
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function openCertificate(path: string, password: string) {
  const opened = new ForgePkcs12Reader().read({ pfx: readFileSync(path), password: Buffer.from(password, 'utf8') });
  if (!opened.ok) fail(`Não foi possível abrir o certificado: ${opened.reason}`);
  const { metadata } = opened.value;
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(metadata.subjectCnpj)) fail('O certificado não traz CNPJ ICP-Brasil.');
  if (metadata.notAfter.getTime() < Date.now()) fail('O certificado está vencido.');
  process.stdout.write(`Certificado: ${metadata.subjectName} (vence em ${metadata.notAfter.toISOString().slice(0, 10)})\n`);
  return {
    privateKey: opened.value.privateKey,
    certificatePem: [opened.value.certificatePem, ...opened.value.chainPem].join(''),
    // ADR-0068: o servidor do SVRS só é aceito se a cadeia terminar na AC Raiz Brasileira v10 versionada.
    serverTrustPem: loadNfceServerTrust(),
  };
}

function report(name: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), operation: `nfce-${name}`, ...data }, null, 1);
  writeFileSync(join(OUT, `${stamp}-${name}.json`), line);
  process.stdout.write(`\nResultado:\n${line}\nGravado em ${OUT}\n`);
}
