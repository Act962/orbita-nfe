import { resolve } from 'node:path';
import { FiscalSchemaCatalog } from '../shared/infrastructure/xml/fiscal-schema-catalog.js';

/**
 * Raiz dos arquivos fiscais oficiais versionados (ADR-0013). Em desenvolvimento, `src/main` →
 * `<repo>/resources`; na imagem, `dist/main` → `/app/resources` (o Dockerfile copia a pasta).
 */
export const FISCAL_SCHEMAS_ROOT = resolve(import.meta.dirname, '../../resources/fiscal/schemas');

/** Carrega e confere (SHA-256) os XSD oficiais. Falha na subida se algum arquivo foi alterado. */
export function loadFiscalSchemas(root: string = FISCAL_SCHEMAS_ROOT): FiscalSchemaCatalog {
  return FiscalSchemaCatalog.load(root);
}
