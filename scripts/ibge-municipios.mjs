// Gera a tabela compacta de municípios (código IBGE de 7 dígitos → nome e UF) a partir da resposta
// OFICIAL do serviço de dados do IBGE, sem alterar nomes nem códigos.
//   curl -o municipios.json https://servicodados.ibge.gov.br/api/v1/localidades/municipios
//   node scripts/ibge-municipios.mjs municipios.json AAAA-MM-DD
// Saída: resources/fiscal/ibge/municipios-AAAA-MM-DD.json. Registre a data, a URL e os dois hashes
// em docs/fiscal/fontes-oficiais.md e troque o arquivo em src/main/fiscal-resources.ts.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const [rawFile, retrievedOn] = process.argv.slice(2);
if (rawFile === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedOn ?? '')) {
  process.stderr.write('uso: node scripts/ibge-municipios.mjs <municipios.json> <AAAA-MM-DD>\n');
  process.exit(1);
}
const raw = readFileSync(rawFile);
const list = JSON.parse(raw.toString('utf8'));
const municipalities = {};
for (const m of list) {
  const code = String(m.id);
  const uf = m['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla ?? m.microrregiao?.mesorregiao?.UF?.sigla;
  if (!/^\d{7}$/.test(code) || typeof m.nome !== 'string' || !/^[A-Z]{2}$/.test(uf ?? '')) throw new Error(`registro inesperado: ${code}`);
  if (municipalities[code] !== undefined) throw new Error(`código repetido: ${code}`);
  municipalities[code] = [m.nome, uf];
}
const sorted = Object.fromEntries(Object.entries(municipalities).sort(([a], [b]) => a.localeCompare(b)));
const table = {
  version: `ibge-municipios/${retrievedOn}`,
  sourceUrl: 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios',
  retrievedOn,
  sourceSha256: createHash('sha256').update(raw).digest('hex'),
  count: Object.keys(sorted).length,
  municipalities: sorted,
};
mkdirSync('resources/fiscal/ibge', { recursive: true });
const out = `resources/fiscal/ibge/municipios-${retrievedOn}.json`;
const body = `${JSON.stringify(table)}\n`;
writeFileSync(out, body);
process.stdout.write(`${out}: ${table.count} municípios; fonte ${table.sourceSha256}; arquivo ${createHash('sha256').update(body).digest('hex')}\n`);
