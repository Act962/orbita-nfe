import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { z } from 'zod';

/**
 * Catálogo dos XSD oficiais versionados em `resources/fiscal/schemas/<documento>/<id>/`
 * (ADR-0013, ADR-0014; promovido do spike 03).
 *
 * - Ao carregar, confere o SHA-256 de cada arquivo contra o `MANIFEST.json`. Qualquer diferença
 *   impede a carga: um XSD alterado não valida nada.
 * - Erratas (`ERRATA.json`) são aplicadas em memória, presas ao hash do arquivo oficial e a uma
 *   única ocorrência do trecho original. Os arquivos oficiais não são alterados.
 * - A validação roda na libxml2 compilada para WebAssembly: sem binding nativo e sem acesso a
 *   disco ou rede. O xmllint só enxerga os arquivos do pacote, passados em memória.
 *
 * As mensagens de erro da libxml2 podem citar valores do documento (nomes, endereços). Elas vão
 * para quem enviou o documento, mas nunca para o log.
 */

export type SchemaEnvironment = 'production' | 'production-restricted';

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9.-]+$/),
  layoutVersion: z.string().min(1),
  namespace: z.string().min(1),
  environments: z.array(z.enum(['production', 'production-restricted'])).min(1),
  publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUrl: z.string().regex(/^https:\/\/www\.gov\.br\//),
  files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});

const errataSchema = z.object({
  package: z.string(),
  entries: z.array(
    z.object({
      id: z.string().min(1),
      file: z.string().min(1),
      fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
      original: z.string().min(1),
      replacement: z.string().min(1),
    }),
  ),
});

export class SchemaCatalogError extends Error {
  constructor(
    readonly code:
      | 'SCHEMA_PACKAGE_INVALID'
      | 'SCHEMA_FILE_TAMPERED'
      | 'SCHEMA_ERRATA_INVALID'
      | 'SCHEMA_PACKAGE_NOT_FOUND'
      | 'SCHEMA_PACKAGE_AMBIGUOUS'
      | 'SCHEMA_ROOT_NOT_FOUND',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SchemaCatalogError';
  }
}

export interface SchemaPackageInfo {
  /** Ex.: `nfse-nacional/1.01-20260209`. Fica gravado no documento validado (ADR-0013). */
  readonly id: string;
  readonly document: string;
  readonly layoutVersion: string;
  readonly namespace: string;
  readonly environments: readonly SchemaEnvironment[];
  readonly publishedOn: string;
  /** Ids das erratas aplicadas, para registro junto do documento. */
  readonly errata: readonly string[];
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<{ readonly message: string; readonly line: number | null }>;
}

interface LoadedPackage {
  readonly info: SchemaPackageInfo;
  readonly files: ReadonlyArray<{ readonly fileName: string; readonly contents: string }>;
}

export interface CatalogOptions {
  /** Só para testes: carrega sem aplicar as erratas, para demonstrar o defeito original. */
  readonly applyErrata?: boolean;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export class FiscalSchemaCatalog {
  private constructor(private readonly byId: ReadonlyMap<string, LoadedPackage>) {}

  /** `root` é o diretório `resources/fiscal/schemas`. */
  static load(root: string, options: CatalogOptions = {}): FiscalSchemaCatalog {
    const packages = new Map<string, LoadedPackage>();
    for (const document of readdirSync(root)) {
      const documentDir = join(root, document);
      if (!statSync(documentDir).isDirectory()) continue;
      for (const entry of readdirSync(documentDir)) {
        const dir = join(documentDir, entry);
        if (!statSync(dir).isDirectory()) continue;
        const loaded = loadPackage(dir, document, options.applyErrata ?? true);
        packages.set(loaded.info.id, loaded);
      }
    }
    return new FiscalSchemaCatalog(packages);
  }

  packages(): readonly SchemaPackageInfo[] {
    return [...this.byId.values()].map((p) => p.info);
  }

  /**
   * O pacote vigente de um documento num ambiente. Enquanto a vigência por data não estiver
   * modelada no manifesto, mais de um pacote para o mesmo ambiente é erro, e não escolha.
   */
  forEnvironment(document: string, environment: SchemaEnvironment): SchemaPackageInfo {
    const matches = this.packages().filter((p) => p.document === document && p.environments.includes(environment));
    if (matches.length > 1) throw new SchemaCatalogError('SCHEMA_PACKAGE_AMBIGUOUS', `${document} em ${environment}: ${matches.map((m) => m.id).join(', ')}`);
    const [only] = matches;
    if (only === undefined) throw new SchemaCatalogError('SCHEMA_PACKAGE_NOT_FOUND', `${document} em ${environment}`);
    return only;
  }

  /** Valida `xml` contra o schema raiz `rootSchema` (ex.: `DPS_v1.01.xsd`) do pacote `packageId`. */
  async validate(packageId: string, rootSchema: string, xml: string): Promise<SchemaValidationResult> {
    const loaded = this.byId.get(packageId);
    if (!loaded) throw new SchemaCatalogError('SCHEMA_PACKAGE_NOT_FOUND', packageId);
    const main = loaded.files.find((f) => f.fileName === rootSchema);
    if (!main) throw new SchemaCatalogError('SCHEMA_ROOT_NOT_FOUND', `${rootSchema} em ${packageId}`);
    const result = await validateXML({
      xml: [{ fileName: 'documento.xml', contents: xml }],
      schema: [main],
      preload: loaded.files.filter((f) => f !== main),
    });
    return {
      valid: result.valid,
      errors: result.errors.map((e) => ({ message: e.message, line: e.loc?.lineNumber ?? null })),
    };
  }
}

function loadPackage(dir: string, document: string, applyErrata: boolean): LoadedPackage {
  const manifestPath = join(dir, 'MANIFEST.json');
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (!parsed.success) throw new SchemaCatalogError('SCHEMA_PACKAGE_INVALID', manifestPath);
  const manifest = parsed.data;
  if (!manifest.id.startsWith(`${document}/`)) throw new SchemaCatalogError('SCHEMA_PACKAGE_INVALID', `${manifest.id} fora de ${document}`);

  const xsdDir = join(dir, 'xsd');
  const onDisk = readdirSync(xsdDir).sort();
  const declared = Object.keys(manifest.files).sort();
  if (JSON.stringify(onDisk) !== JSON.stringify(declared)) throw new SchemaCatalogError('SCHEMA_FILE_TAMPERED', `${manifest.id}: arquivos diferentes do manifesto`);

  const contents = new Map<string, string>();
  for (const [fileName, { sha256: expected }] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(xsdDir, fileName));
    if (sha256(bytes) !== expected) throw new SchemaCatalogError('SCHEMA_FILE_TAMPERED', `${manifest.id}/${fileName}`);
    contents.set(fileName, bytes.toString('utf8'));
  }

  const applied: string[] = [];
  const errataPath = join(dir, 'ERRATA.json');
  if (applyErrata && existsSync(errataPath)) {
    const errata = errataSchema.safeParse(JSON.parse(readFileSync(errataPath, 'utf8')));
    if (!errata.success || errata.data.package !== manifest.id) throw new SchemaCatalogError('SCHEMA_ERRATA_INVALID', errataPath);
    for (const entry of errata.data.entries) {
      const current = contents.get(entry.file);
      // Presa ao arquivo oficial: se o pacote mudar, a errata deixa de valer e precisa ser revista.
      if (current === undefined || manifest.files[entry.file]?.sha256 !== entry.fileSha256) {
        throw new SchemaCatalogError('SCHEMA_ERRATA_INVALID', `${entry.id}: arquivo ${entry.file} não confere`);
      }
      if (current.split(entry.original).length !== 2) throw new SchemaCatalogError('SCHEMA_ERRATA_INVALID', `${entry.id}: trecho original não ocorre exatamente uma vez`);
      contents.set(entry.file, current.replace(entry.original, () => entry.replacement));
      applied.push(entry.id);
    }
  }

  return {
    info: {
      id: manifest.id,
      document,
      layoutVersion: manifest.layoutVersion,
      namespace: manifest.namespace,
      environments: manifest.environments,
      publishedOn: manifest.publishedOn,
      errata: applied,
    },
    files: [...contents].map(([fileName, text]) => ({ fileName, contents: text })),
  };
}
