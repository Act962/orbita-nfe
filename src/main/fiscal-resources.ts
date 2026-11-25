import { resolve } from 'node:path';
import { loadDanfseRenderer, loadRoutingTable, type DanfseRenderer, type RoutingTable } from '../modules/nfse/public.js';
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

/** Tabela de roteamento da NFS-e vigente (ADR-0028). Versão nova = arquivo novo + troca aqui. */
export const NFSE_ROUTING_TABLE_FILE = resolve(import.meta.dirname, '../../resources/fiscal/routing/nfse-routing-2026-11-10.json');

export function loadNfseRouting(path: string = NFSE_ROUTING_TABLE_FILE): RoutingTable {
  return loadRoutingTable(path);
}

/** Logomarca da NFS-e e tabela de municípios do IBGE para o DANFSe (ADR-0057), com os hashes conferidos. */
export const DANFSE_RESOURCES = {
  danfseDir: resolve(import.meta.dirname, '../../resources/fiscal/danfse'),
  ibgeDir: resolve(import.meta.dirname, '../../resources/fiscal/ibge'),
  municipalityFile: 'municipios-2026-11-25.json',
} as const;

export function loadDanfse(paths: typeof DANFSE_RESOURCES = DANFSE_RESOURCES): DanfseRenderer {
  return loadDanfseRenderer(paths);
}
