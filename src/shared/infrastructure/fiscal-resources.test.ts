import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Integridade dos arquivos fiscais oficiais versionados (ADR-0013).
 * Cada pacote em resources/fiscal/schemas/<doc>/<id>/ tem um MANIFEST.json com o
 * SHA-256 do pacote baixado da fonte oficial e de cada arquivo extraído.
 */
interface Manifest {
  id: string;
  environments: string[];
  sourceUrl: string;
  retrievedOn: string;
  package: { file: string; sha256: string };
  files: Record<string, { sha256: string }>;
}

const schemasRoot = resolve(import.meta.dirname, '../../../resources/fiscal/schemas');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const packageDirs = readdirSync(schemasRoot).flatMap((doc) =>
  readdirSync(join(schemasRoot, doc))
    .map((id) => join(schemasRoot, doc, id))
    .filter((dir) => statSync(dir).isDirectory()),
);

describe('arquivos fiscais oficiais (ADR-0013)', () => {
  it('existe ao menos um pacote versionado', () => {
    expect(packageDirs.length).toBeGreaterThan(0);
  });

  describe.each(packageDirs)('%s', (dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as Manifest;

    it('declara origem oficial, data de consulta e ambientes', () => {
      expect(manifest.sourceUrl).toMatch(/^https:\/\/www\.gov\.br\//);
      expect(manifest.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(manifest.environments.length).toBeGreaterThan(0);
    });

    it('o pacote original confere com o SHA-256 do manifesto', () => {
      expect(sha256(join(dir, manifest.package.file))).toBe(manifest.package.sha256);
    });

    it('cada arquivo extraído confere com o manifesto, sem arquivos extras', () => {
      const onDisk = readdirSync(join(dir, 'xsd')).sort();
      expect(onDisk).toEqual(Object.keys(manifest.files).sort());
      for (const [file, { sha256: expected }] of Object.entries(manifest.files)) {
        expect(sha256(join(dir, 'xsd', file)), file).toBe(expected);
      }
    });
  });
});
