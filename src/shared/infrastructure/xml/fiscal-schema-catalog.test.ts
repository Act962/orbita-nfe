import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MINIMAL_DPS_BY_PACKAGE, minimalDps } from '../../../../test/support/dps-fixtures.js';
import { FiscalSchemaCatalog, SchemaCatalogError } from './fiscal-schema-catalog.js';

const ROOT = resolve(import.meta.dirname, '../../../../resources/fiscal/schemas');
const PROD = 'nfse-nacional/1.01-20260209';
const PRODREST = 'nfse-nacional/1.01-20261020-prodrest';

const dpsFor = (id: string) => {
  const build = MINIMAL_DPS_BY_PACKAGE[id];
  if (build === undefined) throw new Error(`sem DPS mínima para ${id}`);
  return build();
};

let catalog: FiscalSchemaCatalog;
beforeAll(() => {
  catalog = FiscalSchemaCatalog.load(ROOT);
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof SchemaCatalogError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('FiscalSchemaCatalog com os XSD oficiais da NFS-e Nacional', () => {
  it('carrega os pacotes versionados e escolhe um por ambiente', () => {
    expect(catalog.forEnvironment('nfse-nacional', 'production').id).toBe(PROD);
    expect(catalog.forEnvironment('nfse-nacional', 'production-restricted').id).toBe(PRODREST);
    expect(codeOf(() => catalog.forEnvironment('nfce', 'production'))).toBe('SCHEMA_PACKAGE_NOT_FOUND');
  });

  it.each([PROD, PRODREST])('%s: a DPS mínima fictícia é válida', async (id) => {
    const result = await catalog.validate(id, 'DPS_v1.01.xsd', dpsFor(id));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  }, 20_000);

  it.each([
    ['valor com vírgula', { vServ: '100,00' }],
    ['texto vazio', { xDescServ: '' }],
    ['número com zero à esquerda', { nDPS: '01' }],
  ])('produção: rejeita %s, com mensagem', async (_name, options) => {
    const result = await catalog.validate(PROD, 'DPS_v1.01.xsd', minimalDps(options));
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBeTruthy();
  }, 20_000);

  it('produção restrita exige finNFSe; o leiaute de produção não aceita', async () => {
    expect((await catalog.validate(PRODREST, 'DPS_v1.01.xsd', minimalDps({ withFinNFSe: false }))).valid).toBe(false);
    expect((await catalog.validate(PROD, 'DPS_v1.01.xsd', minimalDps({ withFinNFSe: true }))).valid).toBe(false);
  }, 20_000);

  it('produção restrita: série de 5 dígitos começando por 9 é recusada pelo XSD (até 89999)', async () => {
    const result = await catalog.validate(PRODREST, 'DPS_v1.01.xsd', minimalDps({ withFinNFSe: true, serie: '90000' }));
    expect(result.valid).toBe(false);
  }, 20_000);

  it('schema raiz ou pacote inexistente é erro, não "válido"', async () => {
    await expect(catalog.validate(PROD, 'Inventado.xsd', minimalDps())).rejects.toMatchObject({ code: 'SCHEMA_ROOT_NOT_FOUND' });
    await expect(catalog.validate('nfse-nacional/0.0', 'DPS_v1.01.xsd', minimalDps())).rejects.toMatchObject({ code: 'SCHEMA_PACKAGE_NOT_FOUND' });
  });
});

describe('XSD-ERRATA-001 (TSSerieDPS no pacote de produção)', () => {
  it('registra a errata aplicada no pacote', () => {
    expect(catalog.packages().find((p) => p.id === PROD)?.errata).toEqual(['XSD-ERRATA-001']);
    expect(catalog.packages().find((p) => p.id === PRODREST)?.errata).toEqual([]);
  });

  it('DEFEITO ORIGINAL: sem a errata, a libxml2 recusa qualquer série, inclusive "1"', async () => {
    const raw = FiscalSchemaCatalog.load(ROOT, { applyErrata: false });
    const result = await raw.validate(PROD, 'DPS_v1.01.xsd', minimalDps({ serie: '1' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message).join(' ')).toContain("^0{0,4}\\d{1,5}$");
  }, 20_000);

  it.each(['1', '00001', '99999'])('com a errata, a série %s é aceita (mesmo significado do padrão ancorado)', async (serie) => {
    expect((await catalog.validate(PROD, 'DPS_v1.01.xsd', minimalDps({ serie }))).valid).toBe(true);
  }, 20_000);

  it.each(['000001', 'A1'])('com a errata, a série %s continua recusada', async (serie) => {
    expect((await catalog.validate(PROD, 'DPS_v1.01.xsd', minimalDps({ serie }))).valid).toBe(false);
  }, 20_000);
});

describe('integridade na carga', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbita-schemas-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const copy = (name: string) => {
    const target = join(dir, name);
    cpSync(ROOT, target, { recursive: true });
    return target;
  };

  it('XSD alterado impede a carga', () => {
    const root = copy('tampered');
    const file = join(root, PROD, 'xsd', 'tiposSimples_v1.01.xsd');
    writeFileSync(file, readFileSync(file, 'utf8').replace('<xs:maxLength value="5"/>', '<xs:maxLength value="6"/>'));
    expect(codeOf(() => FiscalSchemaCatalog.load(root))).toBe('SCHEMA_FILE_TAMPERED');
  });

  it('arquivo a mais na pasta xsd impede a carga', () => {
    const root = copy('extra');
    writeFileSync(join(root, PRODREST, 'xsd', 'extra.xsd'), '<x/>');
    expect(codeOf(() => FiscalSchemaCatalog.load(root))).toBe('SCHEMA_FILE_TAMPERED');
  });

  it('errata presa a outro hash do arquivo oficial impede a carga', () => {
    const root = copy('errata');
    const path = join(root, PROD, 'ERRATA.json');
    const errata = JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<{ fileSha256: string }> };
    for (const entry of errata.entries) entry.fileSha256 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(errata));
    expect(codeOf(() => FiscalSchemaCatalog.load(root))).toBe('SCHEMA_ERRATA_INVALID');
  });

  it('dois pacotes para o mesmo ambiente: ambíguo, não escolhe sozinho', () => {
    const root = copy('ambiguous');
    const clone = join(root, 'nfse-nacional', '1.01-clone');
    cpSync(join(root, PRODREST), clone, { recursive: true });
    const manifestPath = join(clone, 'MANIFEST.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string };
    manifest.id = 'nfse-nacional/1.01-clone';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const loaded = FiscalSchemaCatalog.load(root);
    expect(codeOf(() => loaded.forEnvironment('nfse-nacional', 'production-restricted'))).toBe('SCHEMA_PACKAGE_AMBIGUOUS');
  });
});
