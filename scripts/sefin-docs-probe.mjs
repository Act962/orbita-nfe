// Lê a documentação (Swagger/OpenAPI) da SEFIN Nacional na PRODUÇÃO RESTRITA com o certificado A1
// no mTLS (R-33). SÓ LEITURA: apenas GET, apenas no host da produção restrita, no máximo 12
// requisições. Não envia DPS, evento nem consulta de nota.
//
// Segurança:
// - a senha é pedida no terminal, sem eco, e não é gravada nem impressa;
// - o certificado e a chave ficam só na memória deste processo (nada é gravado em disco);
// - nenhum cabeçalho de resposta é impresso (só status, tipo e tamanho).
//
// Uso:  npm run sefin:docs -- <caminho do .p12/.pfx>
// Saída: os arquivos de documentação em resources/fiscal/sefin-docs/producao-restrita/<data>/,
//        com o SHA-256 de cada um, para registro em docs/fiscal/fontes-oficiais.md.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';
import forge from 'node-forge';

const HOST = 'sefin.producaorestrita.nfse.gov.br';
const START = '/API/SefinNacional/docs/index';
const MAX_REQUESTS = 12;

const p12Path = process.argv[2];
if (p12Path === undefined) {
  process.stderr.write('Uso: npm run sefin:docs -- <caminho do .p12/.pfx>\n');
  process.exit(2);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
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

function loadCredential(path, password) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(readFileSync(path).toString('binary')), password);
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter(Boolean);
  if (keyBag?.key === undefined || certs.length === 0) throw new Error('arquivo sem chave privada ou sem certificado');
  const leaf = certs.find((c) => (c.getExtension('basicConstraints') ?? {}).cA !== true) ?? certs[0];
  return {
    key: forge.pki.privateKeyToPem(keyBag.key),
    cert: [leaf, ...certs.filter((c) => c !== leaf)].map((c) => forge.pki.certificateToPem(c)).join(''),
    notAfter: leaf.validity.notAfter,
  };
}

let requests = 0;
function get(agent, path) {
  return new Promise((resolve, reject) => {
    if (++requests > MAX_REQUESTS) return reject(new Error('limite de requisições atingido'));
    const req = request({ host: HOST, path, method: 'GET', agent, headers: { accept: '*/*', 'user-agent': 'orbita-nfe-docs-probe' }, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), location: res.headers.location, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Segue redirecionamento só dentro do mesmo host. */
async function fetchSameHost(agent, path) {
  let current = path;
  for (let hop = 0; hop < 4; hop++) {
    const res = await get(agent, current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = new URL(res.location, `https://${HOST}${current}`);
      if (next.host !== HOST) return { ...res, path: current, note: `redireciona para outro host (${next.host}): não seguido` };
      current = next.pathname + next.search;
      continue;
    }
    return { ...res, path: current };
  }
  throw new Error('redirecionamentos demais');
}

/** Caminhos de documentação citados no HTML/JS (spec JSON/YAML e o inicializador do Swagger UI). */
function candidates(text, base) {
  const found = new Set();
  for (const m of text.matchAll(/["'`]([^"'`\s]+?\.(?:json|ya?ml)(?:\?[^"'`\s]*)?)["'`]/g)) found.add(m[1]);
  for (const m of text.matchAll(/["'`]([^"'`\s]*swagger-initializer\.js)["'`]/g)) found.add(m[1]);
  // Swagger UI (`url:`/`urls:`) e ReDoc da SEFIN (`initTry({ openApi: '…' })`, observado em 2026-11-13).
  for (const m of text.matchAll(/\b(?:urls?|openApi|specUrl)\s*:\s*["'`]([^"'`]+)["'`]/g)) found.add(m[1]);
  return [...found]
    .map((p) => new URL(p, `https://${HOST}${base}`))
    .filter((u) => u.host === HOST)
    .map((u) => u.pathname + u.search);
}

const password = await askHidden('Senha do certificado: ');
let credential;
try {
  credential = loadCredential(p12Path, password);
} catch (error) {
  process.stderr.write(`Não foi possível abrir o certificado: ${error instanceof Error ? error.message.split('\n')[0] : 'erro'}\n`);
  process.exit(1);
}
process.stdout.write(`Certificado aberto em memória (vence em ${credential.notAfter.toISOString().slice(0, 10)}).\n`);
const agent = new Agent({ key: credential.key, cert: credential.cert, keepAlive: false, maxSockets: 1 });

const day = new Date().toISOString().slice(0, 10);
const outDir = join('resources', 'fiscal', 'sefin-docs', 'producao-restrita', day);
mkdirSync(outDir, { recursive: true });

const queue = [START];
const seen = new Set();
const saved = [];
while (queue.length > 0 && requests < MAX_REQUESTS) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  let res;
  try {
    res = await fetchSameHost(agent, path);
  } catch (error) {
    process.stdout.write(`GET ${path} → erro: ${error instanceof Error ? error.message : 'erro'}\n`);
    continue;
  }
  process.stdout.write(`GET ${res.path} → ${res.status} ${res.type.split(';')[0]} (${res.body.length} bytes)${res.note ? ` — ${res.note}` : ''}\n`);
  if (res.status !== 200) continue;
  const text = res.body.toString('utf8');
  const plain = res.path.split('?')[0];
  const extension = /\.(json|ya?ml|js|html?)$/.test(plain) ? '' : /json/.test(res.type) ? '.json' : /ya?ml/.test(res.type) ? '.yaml' : '.html';
  const name = `${plain.split('/').filter(Boolean).slice(-2).join('-') || 'index'}${extension}`;
  writeFileSync(join(outDir, name), res.body);
  saved.push({ file: join(outDir, name), sha256: createHash('sha256').update(res.body).digest('hex'), bytes: res.body.length });
  if (/html|javascript/.test(res.type) || /\.(html?|js)$/.test(name)) for (const c of candidates(text, res.path)) if (!seen.has(c)) queue.push(c);
}
agent.destroy();

process.stdout.write(`\nArquivos salvos (${saved.length}):\n`);
for (const s of saved) process.stdout.write(`  ${s.file}  sha256=${s.sha256}  ${s.bytes} bytes\n`);
process.stdout.write('\nNada foi enviado além de GET de documentação. A senha não foi gravada.\n');
