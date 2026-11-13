import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { ForgePkcs12Reader } from '../modules/certificates/public.js';
import {
  brasiliaDate,
  buildDpsId,
  checkDpsRules,
  NationalNfseGateway,
  SEFIN_NACIONAL,
  XmlDpsPreparer,
  type DpsData,
  type GatewayContext,
  type ServiceInvoice,
} from '../modules/nfse/public.js';
import { loadFiscalSchemas } from './fiscal-resources.js';

/**
 * Teste de transporte com a SEFIN Nacional na PRODUÇÃO RESTRITA (ADR-0038), sem banco e sem
 * cofre: usa o MESMO preparador (XML, regras, assinatura, XSD) e o MESMO adapter do worker-fiscal.
 *
 *   npm run sefin:test -- send <certificado.p12> --municipality 2211001 --simples 1
 *   npm run sefin:test -- lookup <certificado.p12> --dps <Id da DPS>
 *   npm run sefin:test -- resend <certificado.p12> --file .local/sefin-teste/<…>-dps-assinada.xml
 *
 * `resend` reenvia OS MESMOS BYTES já assinados, e só depois de uma consulta com NOT_FOUND
 * (mesma regra do worker: dúvida se resolve consultando, nunca gerando outra DPS).
 *
 * Garantias:
 * - só HOMOLOGATION (tpAmb = 2); o perfil nem tem URL de produção;
 * - DPS com dados FICTÍCIOS: R$ 1,00, sem tomador, série de teste 900, descrição que diz ser teste;
 * - a senha é pedida no terminal, sem eco; certificado e chave só na memória;
 * - grava em `.local/sefin-teste/` (fora do git) só a DPS assinada e o resultado (códigos);
 * - nunca reenvia sozinho: depois de UNKNOWN, use `lookup` com o Id da DPS.
 *
 * Sem `process.exit` depois do prompt: no Windows, sair com o stdin recém-fechado derruba o
 * Node (assert do libuv em async.c). O código de saída vai em `process.exitCode`.
 */
const TEST_SERIES = '900';
const OUT = join('.local', 'sefin-teste');
const USAGE =
  'uso: sefin:test send <cert.p12> --municipality <IBGE 7> --simples <1|2|3> [--regime <1|2|3>]\n' +
  '     sefin:test lookup <cert.p12> --dps <Id da DPS>\n' +
  '     sefin:test resend <cert.p12> --file <dps-assinada.xml>   (só depois de lookup NOT_FOUND)\n';

/** Interrompe o comando com mensagem e código 2, sem `process.exit`. */
class Stop extends Error {}

function fail(message: string): never {
  throw new Stop(message.endsWith('\n') ? message : `${message}\n`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { municipality: { type: 'string' }, simples: { type: 'string' }, regime: { type: 'string' }, dps: { type: 'string' }, file: { type: 'string' } },
});
const [command, p12Path] = positionals;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let responses = 0;
// Respostas brutas da SEFIN, para diagnóstico: só em .local/ (fora do git), nunca em log.
const gateway = new NationalNfseGateway(SEFIN_NACIONAL, undefined, (r) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${stamp}-resposta-${++responses}-${r.method}-${r.status}.json`), `${r.method} ${r.path}\n${r.body}`);
});

try {
  if ((command !== 'send' && command !== 'lookup' && command !== 'resend') || p12Path === undefined) fail(USAGE);
  const password = await askHidden('Senha do certificado: ');
  const { context, cnpj } = openCertificate(p12Path, password);
  mkdirSync(OUT, { recursive: true });
  if (command === 'lookup') await lookup(context);
  else if (command === 'resend') await resend(context);
  else await send(context, cnpj);
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

function openCertificate(path: string, password: string): { context: GatewayContext; cnpj: string } {
  const opened = new ForgePkcs12Reader().read({ pfx: readFileSync(path), password: Buffer.from(password, 'utf8') });
  if (!opened.ok) fail(`Não foi possível abrir o certificado: ${opened.reason}`);
  const { metadata } = opened.value;
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(metadata.subjectCnpj)) fail('O certificado não traz CNPJ ICP-Brasil.');
  if (metadata.notAfter.getTime() < Date.now()) fail('O certificado está vencido.');
  process.stdout.write(`Certificado: ${metadata.subjectName} (vence em ${metadata.notAfter.toISOString().slice(0, 10)})\n`);
  const credential = { privateKey: opened.value.privateKey, certificatePem: [opened.value.certificatePem, ...opened.value.chainPem].join('') };
  return { context: { environment: 'HOMOLOGATION', credential }, cnpj: metadata.subjectCnpj };
}

async function lookup(context: GatewayContext): Promise<void> {
  const dpsId = values.dps ?? fail(USAGE);
  const result = await gateway.findByDpsId(dpsId, context);
  report('lookup', { dpsId, kind: result.kind, ...(result.kind === 'FOUND' ? { accessKey: result.accessKey } : {}), ...(result.kind === 'ERROR' ? { errorCode: result.errorCode } : {}) });
  if (result.kind === 'FOUND') writeFileSync(join(OUT, `${stamp}-nfse.xml`), result.nfseXml);
}

async function resend(context: GatewayContext): Promise<void> {
  const signedXml = readFileSync(values.file ?? fail(USAGE), 'utf8');
  const dpsId = /<infDPS[^>]*\sId="(DPS[0-9A-Z]{42})"/.exec(signedXml)?.[1] ?? fail('O arquivo não é uma DPS assinada.');
  // A regra do worker: só reenvia o que a consulta disse que não existe.
  const before = await gateway.findByDpsId(dpsId, context);
  if (before.kind !== 'NOT_FOUND') {
    report('resend-blocked', { dpsId, lookup: before.kind, ...(before.kind === 'ERROR' ? { errorCode: before.errorCode } : {}), ...(before.kind === 'FOUND' ? { accessKey: before.accessKey } : {}) });
    return;
  }
  process.stdout.write(`Consulta: a DPS ${dpsId} não existe na SEFIN. Reenviando os mesmos bytes...\n`);
  const again = await gateway.submit(signedXml, context);
  report('resend', {
    dpsId,
    kind: again.kind,
    ...(again.kind === 'AUTHORIZED' ? { accessKey: again.accessKey } : {}),
    ...(again.kind === 'REJECTED' ? { code: again.code, message: again.message } : {}),
    ...(again.kind === 'NOT_SENT' || again.kind === 'UNKNOWN' ? { errorCode: again.errorCode } : {}),
  });
  if (again.kind === 'AUTHORIZED') writeFileSync(join(OUT, `${stamp}-nfse.xml`), again.nfseXml);
  if (again.kind === 'UNKNOWN' || again.kind === 'ALREADY_EXISTS') process.stdout.write(`Não reenvie. Consulte de novo com lookup --dps ${dpsId}\n`);
}

async function send(context: GatewayContext, cnpj: string): Promise<void> {
  const municipality = values.municipality ?? fail(USAGE);
  const simples = values.simples;
  if (!/^[0-9]{7}$/.test(municipality)) fail('--municipality: código IBGE de 7 dígitos (município do estabelecimento).');
  if (simples !== '1' && simples !== '2' && simples !== '3') fail('--simples: 1 (não optante), 2 (MEI) ou 3 (ME/EPP), conforme o enquadramento REAL da empresa.');
  const regime = values.regime;
  if (regime !== undefined && regime !== '1' && regime !== '2' && regime !== '3') fail('--regime: 1, 2 ou 3 (só para ME/EPP).');

  // DPS FICTÍCIA: valor simbólico, sem tomador, sem retenção, sem alíquota. O enquadramento é o real
  // (informado pelo responsável); os demais valores existem só para o teste de transporte.
  const dps: DpsData = {
    competenceDate: brasiliaDate(new Date()),
    provider: { simplesNacionalOption: simples, ...(regime === undefined ? {} : { simplesNacionalRegime: regime }), specialTaxRegime: '0' },
    service: { municipalityCode: municipality, nationalTaxCode: '010101', description: 'TESTE DE INTEGRACAO EM PRODUCAO RESTRITA - SEM VALOR FISCAL' },
    values: { serviceAmount: '1.00', issqn: { taxation: '1', retention: '1' }, approximateTaxes: { kind: 'AMOUNTS', federal: '0.00', state: '0.00', municipal: '0.00' } },
  };
  const violations = checkDpsRules(dps, { environment: 'HOMOLOGATION', providerCnpj: cnpj, issueDate: brasiliaDate(new Date()) });
  if (violations.length > 0) fail(`A DPS de teste viola regras do Anexo I: ${violations.map((v) => `${v.code} (${v.field})`).join(', ')}`);

  const number = Math.floor(Date.now() / 1000) % 1_000_000_000;
  const dpsId = buildDpsId({ municipalityCode: municipality, registration: { kind: 'CNPJ', value: cnpj }, series: TEST_SERIES, number });
  if (!dpsId.ok) fail(`Id da DPS inválido: ${dpsId.error}`);

  const invoice = {
    id: '00000000-0000-0000-0000-000000000000',
    environment: 'HOMOLOGATION',
    dpsId: dpsId.value,
    series: TEST_SERIES,
    number,
    payload: dps,
    substitution: null,
  } as unknown as ServiceInvoice;
  const prepared = await new XmlDpsPreparer(loadFiscalSchemas(), 'orbita-nfe-teste').prepare(invoice, context.credential);
  if (!prepared.ok) fail(`Falha local antes do envio (nada saiu): ${prepared.code}`);
  writeFileSync(join(OUT, `${stamp}-dps-assinada.xml`), prepared.signedXml);
  process.stdout.write(`DPS ${dpsId.value} montada, assinada e válida no XSD (${prepared.layoutPackage}). Enviando à produção restrita...\n`);

  const result = await gateway.submit(prepared.signedXml, context);
  report('send', {
    dpsId: dpsId.value,
    kind: result.kind,
    ...(result.kind === 'AUTHORIZED' ? { accessKey: result.accessKey } : {}),
    ...(result.kind === 'REJECTED' ? { code: result.code, message: result.message } : {}),
    ...(result.kind === 'NOT_SENT' || result.kind === 'UNKNOWN' ? { errorCode: result.errorCode } : {}),
  });
  if (result.kind === 'AUTHORIZED') writeFileSync(join(OUT, `${stamp}-nfse.xml`), result.nfseXml);
  if (result.kind === 'UNKNOWN' || result.kind === 'ALREADY_EXISTS') {
    process.stdout.write(`Não reenvie. Consulte depois: npm run sefin:test -- lookup <cert.p12> --dps ${dpsId.value}\n`);
  }
}

function report(kind: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), operation: kind, ...data }, null, 1);
  writeFileSync(join(OUT, `${stamp}-${kind}.json`), line);
  process.stdout.write(`\nResultado:\n${line}\nGravado em ${OUT}\n`);
}
