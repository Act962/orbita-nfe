// Gera a tabela do ANEXO_A do Sistema Nacional NFS-e (municípios IBGE, países ISO2 e localidade
// geral) a partir da planilha OFICIAL, sem alterar códigos nem nomes.
//   curl -o anexo_a.xlsx https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_a-municipio_ibge-paises_iso2-v1-00-snnfse-20251210.xlsx
//   node scripts/anexo-a.mjs anexo_a.xlsx v1.00-20251210
// Saída: resources/fiscal/nfse-anexo-a/anexo-a-<versão>.json (a planilha vai junto, para conferência).
// Registre a data, a URL e os hashes em docs/fiscal/fontes-oficiais.md e no MANIFEST.json da pasta.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { inflateRawSync } from 'node:zlib';

const [xlsxFile, version] = process.argv.slice(2);
if (xlsxFile === undefined || !/^v\d+\.\d+-\d{8}$/.test(version ?? '')) {
  process.stderr.write('uso: node scripts/anexo-a.mjs <anexo_a.xlsx> <vX.YY-AAAAMMDD>\n');
  process.exit(1);
}

/** Leitor mínimo de zip (diretório central + deflate), suficiente para um .xlsx. */
function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('não é um zip');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('diretório central inválido');
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const texts = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

const raw = readFileSync(xlsxFile);
const files = unzip(raw);
const read = (name) => files.get(name)?.toString('utf8') ?? '';
const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));

/** Linhas da aba como { coluna: valor }, lidas pela letra da coluna (há células vazias no meio). */
function sheet(sheetName) {
  const found = [...read('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].find((m) => decode(m[1]) === sheetName);
  if (found === undefined) throw new Error(`aba ausente: ${sheetName}`);
  const target = rels.get(found[2]).replace(/^\/?(xl\/)?/, 'xl/');
  return [...read(target).matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
    const cells = {};
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const value = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '')?.[1];
      const type = /t="([^"]+)"/.exec(c[2])?.[1];
      cells[c[1]] = (type === 's' ? shared[Number(value)] : type === 'inlineStr' ? texts(c[3] ?? '') : decode(value ?? '')).trim();
    }
    return cells;
  });
}

const [munHeader, ...munRows] = sheet('TAB.MUN_IBGE');
if (munHeader.D !== 'CÓDIGO COMPLETO') throw new Error('cabeçalho de TAB.MUN_IBGE mudou');
const municipalities = {};
for (const r of munRows) {
  if (!/^\d{7}$/.test(r.D ?? '') || !r.C) throw new Error(`linha inesperada em TAB.MUN_IBGE: ${JSON.stringify(r)}`);
  if (municipalities[r.D] !== undefined) throw new Error(`código repetido: ${r.D}`);
  // A coluna da sigla da UF vem vazia em boa parte das linhas; o nome da UF vem sempre.
  municipalities[r.D] = r.C;
}
const [countryHeader, ...countryRows] = sheet('TAB.PAÍS_ISO2');
if (countryHeader.A !== 'PAÍS ISO 2') throw new Error('cabeçalho de TAB.PAÍS_ISO2 mudou');
const countries = {};
for (const r of countryRows) {
  if (!/^[A-Z]{2}$/.test(r.A ?? '') || !r.B) throw new Error(`linha inesperada em TAB.PAÍS_ISO2: ${JSON.stringify(r)}`);
  countries[r.A] = r.B;
}
const [, ...generalRows] = sheet('TAB.LOC.GERAL');
const generalLocations = Object.fromEntries(generalRows.filter((r) => /^\d{7}$/.test(r.B ?? '') && r.A).map((r) => [r.B, r.A]));

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const table = {
  version: `nfse-anexo-a/${version}`,
  sourceUrl: 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_a-municipio_ibge-paises_iso2-v1-00-snnfse-20251210.xlsx',
  sourceSha256: createHash('sha256').update(raw).digest('hex'),
  municipalities: sorted(municipalities),
  countries: sorted(countries),
  generalLocations: sorted(generalLocations),
};
mkdirSync('resources/fiscal/nfse-anexo-a', { recursive: true });
const out = `resources/fiscal/nfse-anexo-a/anexo-a-${version}.json`;
const body = `${JSON.stringify(table)}\n`;
writeFileSync(out, body);
copyFileSync(xlsxFile, `resources/fiscal/nfse-anexo-a/anexo-a-${version}.xlsx`);
process.stdout.write(
  `${out}: ${Object.keys(municipalities).length} municípios, ${Object.keys(countries).length} países, ${Object.keys(generalLocations).length} localidade(s) geral(is); ` +
    `planilha ${table.sourceSha256}; arquivo ${createHash('sha256').update(body).digest('hex')}\n`,
);
