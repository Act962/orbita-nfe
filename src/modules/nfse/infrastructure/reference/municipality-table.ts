import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MunicipalityDirectory } from '../../application/ports.js';

/**
 * Tabela oficial de municípios do IBGE (ADR-0057, ADR-0058), versionada em `resources/fiscal/ibge`
 * com o SHA-256 no MANIFEST.json, conferido na carga como os XSD (ADR-0013).
 */
export interface MunicipalityTable extends MunicipalityDirectory {
  readonly version: string;
  lookup(code: string): { readonly name: string; readonly uf: string } | undefined;
}

export class ReferenceResourceError extends Error {
  constructor(readonly code: 'REFERENCE_RESOURCE_INVALID' | 'REFERENCE_RESOURCE_HASH_MISMATCH', readonly file: string) {
    super(`${code}: ${file}`);
    this.name = 'ReferenceResourceError';
  }
}

const manifestSchema = z.object({ files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })) });

const tableSchema = z.object({
  version: z.string().regex(/^ibge-municipios\/\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().positive(),
  municipalities: z.record(z.string().regex(/^\d{7}$/), z.tuple([z.string().min(1), z.string().regex(/^[A-Z]{2}$/)])),
});

/** Arquivo listado no MANIFEST.json da pasta, com o SHA-256 conferido. Alterado ou fora da lista: erro. */
export function verifiedResource(dir: string, file: string): Buffer {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')));
  } catch {
    throw new ReferenceResourceError('REFERENCE_RESOURCE_INVALID', join(dir, 'MANIFEST.json'));
  }
  const expected = manifest.files[file]?.sha256;
  const bytes = readFileSync(join(dir, file));
  if (expected === undefined || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new ReferenceResourceError('REFERENCE_RESOURCE_HASH_MISMATCH', join(dir, file));
  }
  return bytes;
}

export function loadMunicipalityTable(dir: string, file: string): MunicipalityTable {
  const parsed = tableSchema.safeParse(JSON.parse(verifiedResource(dir, file).toString('utf8')));
  if (!parsed.success || Object.keys(parsed.data.municipalities).length !== parsed.data.count) {
    throw new ReferenceResourceError('REFERENCE_RESOURCE_INVALID', join(dir, file));
  }
  const table = parsed.data.municipalities;
  return {
    version: parsed.data.version,
    exists: (code) => Object.hasOwn(table, code),
    lookup: (code) => {
      const found = Object.hasOwn(table, code) ? table[code] : undefined;
      return found === undefined ? undefined : { name: found[0], uf: found[1] };
    },
  };
}
