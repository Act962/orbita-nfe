import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ForgePkcs12Reader } from '../modules/certificates/public.js';
import { queryServiceStatus, SVRS_NFCE_STATUS } from '../modules/nfce/public.js';
import { createMtlsAgent } from '../shared/infrastructure/transport/mtls-transport.js';
import { loadFiscalSchemas } from './fiscal-resources.js';

/**
 * Consulta do STATUS DO SERVIÇO da NFC-e no SVRS, em HOMOLOGAÇÃO (ADR-0063). Não emite nota.
 *
 *   npm run nfce:test -- status <certificado.p12> [--uf 22]
 *
 * - Só homologação (tpAmb = 2); não há URL de produção aqui.
 * - `--uf` é o código IBGE da UF consultada (padrão 22, Piauí). A regra K02 do MOC recusa (cStat
 *   289) a UF que o webservice não atende: um 107 com cUF 22 confirma que o SVRS atende o PI.
 * - A senha é pedida sem eco; certificado e chave só na memória.
 * - Grava em `.local/nfce-teste/` (fora do git) a resposta SOAP e o resumo.
 * - MOC 7.0, item 5.5.3: no mínimo 3 minutos entre consultas de status. O CLI recusa antes disso.
 */
const OUT = join('.local', 'nfce-teste');
const LAST = join(OUT, 'ultima-consulta-status.txt');
const MIN_INTERVAL_MS = 3 * 60 * 1000;
const USAGE = 'uso: nfce:test status <cert.p12> [--uf <código IBGE da UF, 2 dígitos; padrão 22>]\n';

class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message.endsWith('\n') ? message : `${message}\n`);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: { uf: { type: 'string', default: '22' } } });
const [command, p12Path] = positionals;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

try {
  if (command !== 'status' || p12Path === undefined) fail(USAGE);
  const uf = values.uf;
  if (!/^[0-9]{2}$/.test(uf)) fail('--uf: código IBGE da UF com 2 dígitos (PI = 22).');
  mkdirSync(OUT, { recursive: true });
  if (existsSync(LAST)) {
    const elapsed = Date.now() - Date.parse(readFileSync(LAST, 'utf8').trim());
    if (elapsed < MIN_INTERVAL_MS) fail(`Aguarde ${Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000)} s: o MOC pede no mínimo 3 minutos entre consultas de status.`);
  }
  const url = SVRS_NFCE_STATUS.HOMOLOGATION;
  process.stdout.write(`Autorizador: SVRS, NFC-e, homologação (${url})\n`);
  const password = await askHidden('Senha do certificado: ');
  const identity = openCertificate(p12Path, password);
  const agent = createMtlsAgent(identity, { connectTimeoutMs: 10_000, headersTimeoutMs: 30_000, bodyTimeoutMs: 30_000, maxResponseBytes: 512 * 1024 });
  writeFileSync(LAST, new Date().toISOString());
  try {
    const result = await queryServiceStatus({ agent, url, query: { tpAmb: '2', cUF: uf }, catalog: loadFiscalSchemas() });
    // A resposta SOAP vai inteira para .local/; no terminal e no resumo, só os campos.
    const responseXml = 'responseXml' in result ? result.responseXml : undefined;
    if (responseXml !== undefined) writeFileSync(join(OUT, `${stamp}-resposta-status.xml`), responseXml);
    report({ uf, ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'responseXml')) });
    if (result.kind === 'STATUS') {
      // Anexo I, item 4.4.1: 107 Serviço em Operação; 108 paralisado momentaneamente; 109 sem previsão.
      const meaning = { '107': 'serviço em operação', '108': 'paralisado momentaneamente', '109': 'paralisado sem previsão' }[result.status.cStat];
      process.stdout.write(`cStat ${result.status.cStat}: ${result.status.xMotivo}${meaning === undefined ? '' : ` (${meaning})`}\n`);
    }
  } finally {
    await agent.close();
  }
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(error.message);
  process.exitCode = 2;
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
  return { privateKey: opened.value.privateKey, certificatePem: [opened.value.certificatePem, ...opened.value.chainPem].join('') };
}

function report(data: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), operation: 'nfce-status', ...data }, null, 1);
  writeFileSync(join(OUT, `${stamp}-status.json`), line);
  process.stdout.write(`\nResultado:\n${line}\nGravado em ${OUT}\n`);
}
