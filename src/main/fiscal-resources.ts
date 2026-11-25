import { resolve } from 'node:path';
import {
  loadAnexoA,
  loadDanfseRenderer,
  loadMunicipalityTable,
  loadRoutingTable,
  referenceTables,
  type DanfseRenderer,
  type FiscalReferenceTables,
  type MunicipalityTable,
  type RoutingTable,
} from '../modules/nfse/public.js';
import { loadServerTrust } from '../modules/nfce/public.js';
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

/** Tabela de municípios do IBGE (ADR-0057, ADR-0058), com o hash conferido na carga. */
export const MUNICIPALITY_TABLE = {
  dir: resolve(import.meta.dirname, '../../resources/fiscal/ibge'),
  file: 'municipios-2026-11-25.json',
} as const;

export function loadMunicipalities(table: typeof MUNICIPALITY_TABLE = MUNICIPALITY_TABLE): MunicipalityTable {
  return loadMunicipalityTable(table.dir, table.file);
}

/** Logomarca oficial da NFS-e para o DANFSe (ADR-0057), com o hash conferido na carga. */
export const DANFSE_DIR = resolve(import.meta.dirname, '../../resources/fiscal/danfse');

export function loadDanfse(municipalities: MunicipalityTable, dir: string = DANFSE_DIR): DanfseRenderer {
  return loadDanfseRenderer(dir, municipalities);
}

/** AC Raiz Brasileira v10 (ICP-Brasil), âncora do TLS do SVRS na NFC-e (ADR-0068), com o hash conferido na carga. */
export const NFCE_SERVER_TRUST_DIR = resolve(import.meta.dirname, '../../resources/fiscal/trust/icp-brasil');

export function loadNfceServerTrust(dir: string = NFCE_SERVER_TRUST_DIR): string {
  return loadServerTrust(dir);
}

/** ANEXO_A do Sistema Nacional NFS-e (ADR-0060), com o hash conferido na carga. */
export const ANEXO_A = {
  dir: resolve(import.meta.dirname, '../../resources/fiscal/nfse-anexo-a'),
  file: 'anexo-a-v1.00-20251210.json',
} as const;

/** Tabelas de referência do aceite: ANEXO_A + IBGE (ADR-0058, ADR-0060). */
export function loadReferenceTables(municipalities: MunicipalityTable, anexoA: typeof ANEXO_A = ANEXO_A): FiscalReferenceTables {
  return referenceTables(loadAnexoA(anexoA.dir, anexoA.file), municipalities);
}
