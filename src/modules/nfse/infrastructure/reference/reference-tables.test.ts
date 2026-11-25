import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAnexoA, referenceTables } from './anexo-a.js';
import { loadMunicipalityTable } from './municipality-table.js';

/** Arquivos oficiais versionados (ADR-0057, ADR-0060), com o hash conferido na carga. */
const RESOURCES = resolve(import.meta.dirname, '../../../../../resources/fiscal');
const ibge = loadMunicipalityTable(`${RESOURCES}/ibge`, 'municipios-2026-11-25.json');
const anexoA = loadAnexoA(`${RESOURCES}/nfse-anexo-a`, 'anexo-a-v1.00-20251210.json');
const tables = referenceTables(anexoA, ibge);

describe('tabelas de referência do aceite (ADR-0058, ADR-0060)', () => {
  it('ANEXO_A v1.00: municípios, países ISO2 e a localidade geral "Águas Marítimas"', () => {
    expect(anexoA.version).toBe('nfse-anexo-a/v1.00-20251210');
    expect(anexoA.hasMunicipality('2211001')).toBe(true);
    expect(anexoA.hasCountry('PT')).toBe(true);
    expect(anexoA.hasCountry('ZZ')).toBe(true);
    expect(anexoA.hasCountry('XX')).toBe(false);
    expect(anexoA.hasGeneralLocation('0000000')).toBe(true);
  });

  it('município: existe no ANEXO_A OU no IBGE (o ANEXO_A v1.00 não tem 5101837, instalado depois)', () => {
    expect(anexoA.hasMunicipality('5101837')).toBe(false);
    expect(ibge.exists('5101837')).toBe(true);
    expect(tables.municipalityExists('5101837')).toBe(true);
    expect(tables.municipalityExists('2211001')).toBe(true);
    expect(tables.municipalityExists('9999999')).toBe(false);
  });

  it('país: só o ANEXO_A', () => {
    expect(tables.countryExists('US')).toBe(true);
    expect(tables.countryExists('XX')).toBe(false);
  });

  it('arquivo alterado ou fora do MANIFEST impede a carga', () => {
    expect(() => loadAnexoA(`${RESOURCES}/nfse-anexo-a`, 'nao-existe.json')).toThrow();
    expect(() => loadAnexoA(`${RESOURCES}/ibge`, 'municipios-2026-11-25.json')).toThrow();
  });
});
