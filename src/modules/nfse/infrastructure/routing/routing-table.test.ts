import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { route, type RoutingInput } from '../../domain/routing.js';
import { loadRoutingTable, RoutingTableError } from './routing-table.js';

const FILE = resolve(import.meta.dirname, '../../../../../resources/fiscal/routing/nfse-routing-2026-11-10.json');
const table = loadRoutingTable(FILE);
const TERESINA = '2211001';
const OTHER = '3550308';

const input = (overrides: Partial<RoutingInput>): RoutingInput => ({
  municipalityCode: TERESINA,
  simplesNacionalOption: '3',
  simplesNacionalRegime: '1',
  competenceDate: '2026-11-12',
  ...overrides,
});

describe('tabela de roteamento vigente (ADR-0028 item 5)', () => {
  it('carrega a versão aprovada; toda linha tem fonte', () => {
    expect(table.version).toBe('nfse-routing/2026-11-10');
    expect(table.rows.map((r) => r.id)).toEqual([
      'MEI-NACIONAL',
      'MEEPP-SUBLIMITE-NACIONAL',
      'TERESINA-MEEPP-FORA-SUBLIMITE',
      'TERESINA-COMPETENCIA-ANTERIOR',
      'TERESINA-NAO-OPTANTE',
    ]);
    for (const row of table.rows) expect(row.source.length).toBeGreaterThan(10);
  });

  it('ME/EPP dentro do sublimite (regApTribSN 1), competência ≥ 01/11/2026 → SEFIN Nacional, em Teresina ou fora', () => {
    for (const municipalityCode of [TERESINA, OTHER]) {
      expect(route(table, input({ municipalityCode }))).toEqual({ kind: 'ROUTED', channel: 'NATIONAL_SEFIN', rows: ['MEEPP-SUBLIMITE-NACIONAL'] });
    }
    expect(route(table, input({ competenceDate: '2026-11-01' }))).toMatchObject({ kind: 'ROUTED', channel: 'NATIONAL_SEFIN' });
  });

  it('MEI → SEFIN Nacional fora de Teresina e, em Teresina, a partir de 11/2026', () => {
    expect(route(table, input({ municipalityCode: OTHER, simplesNacionalOption: '2', simplesNacionalRegime: undefined, competenceDate: '2026-05-10' }))).toEqual({
      kind: 'ROUTED',
      channel: 'NATIONAL_SEFIN',
      rows: ['MEI-NACIONAL'],
    });
    expect(route(table, input({ simplesNacionalOption: '2', simplesNacionalRegime: undefined }))).toMatchObject({ kind: 'ROUTED', channel: 'NATIONAL_SEFIN' });
  });

  it('MEI em Teresina com competência anterior: duas linhas com canais diferentes → AMBIGUOUS (a tabela não define precedência)', () => {
    expect(route(table, input({ simplesNacionalOption: '2', simplesNacionalRegime: undefined, competenceDate: '2026-10-31' }))).toEqual({
      kind: 'AMBIGUOUS',
      rows: ['MEI-NACIONAL', 'TERESINA-COMPETENCIA-ANTERIOR'],
    });
  });

  it('Teresina, ME/EPP fora do sublimite (regApTribSN 2 ou 3) → TO_CONFIRM', () => {
    for (const regime of ['2', '3']) {
      expect(route(table, input({ simplesNacionalRegime: regime }))).toEqual({ kind: 'TO_CONFIRM', rows: ['TERESINA-MEEPP-FORA-SUBLIMITE'] });
    }
  });

  it('Teresina, competência anterior a 11/2026 ou não optante → emissor municipal', () => {
    expect(route(table, input({ competenceDate: '2026-10-31' }))).toEqual({ kind: 'ROUTED', channel: 'MUNICIPAL_TERESINA_DSF', rows: ['TERESINA-COMPETENCIA-ANTERIOR'] });
    expect(route(table, input({ simplesNacionalOption: '1', simplesNacionalRegime: undefined }))).toEqual({
      kind: 'ROUTED',
      channel: 'MUNICIPAL_TERESINA_DSF',
      rows: ['TERESINA-NAO-OPTANTE'],
    });
    // Não optante e retroativa: duas linhas, mesmo canal.
    expect(route(table, input({ simplesNacionalOption: '1', simplesNacionalRegime: undefined, competenceDate: '2026-01-15' }))).toMatchObject({
      kind: 'ROUTED',
      channel: 'MUNICIPAL_TERESINA_DSF',
    });
  });

  it('sem linha → NO_ROUTE; ME/EPP sem regime informado → NO_ROUTE pedindo o regime', () => {
    expect(route(table, input({ municipalityCode: OTHER, simplesNacionalOption: '1', simplesNacionalRegime: undefined }))).toEqual({ kind: 'NO_ROUTE', regimeWouldMatter: false });
    expect(route(table, input({ municipalityCode: OTHER, competenceDate: '2026-10-31' }))).toEqual({ kind: 'NO_ROUTE', regimeWouldMatter: false });
    expect(route(table, input({ simplesNacionalRegime: undefined }))).toEqual({ kind: 'NO_ROUTE', regimeWouldMatter: true });
  });
});

describe('carga da tabela', () => {
  const write = (mutate: (t: Record<string, unknown> & { rows: Record<string, unknown>[] }) => void): string => {
    const data = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown> & { rows: Record<string, unknown>[] };
    mutate(data);
    const path = join(mkdtempSync(join(tmpdir(), 'routing-')), 'tabela.json');
    writeFileSync(path, JSON.stringify(data));
    return path;
  };

  it.each([
    ['linha sem fonte', (t: { rows: Record<string, unknown>[] }) => (t.rows[0] = { ...t.rows[0], source: '' })],
    ['canal desconhecido', (t: { rows: Record<string, unknown>[] }) => (t.rows[0] = { ...t.rows[0], channel: 'PADRAO' })],
    ['id repetido', (t: { rows: Record<string, unknown>[] }) => t.rows.push({ ...t.rows[0] })],
    ['faixa vazia', (t: { rows: Record<string, unknown>[] }) => (t.rows[0] = { ...t.rows[0], competenceFrom: '2026-11-01', competenceBefore: '2026-11-01' })],
    ['campo a mais', (t: { rows: Record<string, unknown>[] }) => (t.rows[0] = { ...t.rows[0], default: true })],
  ])('%s → ROUTING_TABLE_INVALID', (_name, mutate) => {
    expect(() => loadRoutingTable(write(mutate))).toThrow(RoutingTableError);
  });
});
