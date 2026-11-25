import type { Agent } from 'undici';
import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { callSefaz, childText, NFE_NS, readSefazResponse, type SefazFailure } from './sefaz-soap.js';

/**
 * Consulta do status do serviço da NFC-e (`NfeStatusServico4`), ADR-0063. Não emite nada.
 *
 * Fontes: MOC 7.0, Visão Geral, item 5.5 (leiaute e regras K01 a K04); schemas
 * `consStatServ_v4.00.xsd` e `retConsStatServ_v4.00.xsd` do PL_009q (ADR-0062); endereço do SVRS
 * na relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS).
 */
export const SVRS_NFCE_STATUS = {
  HOMOLOGATION: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
} as const;

/** Pacote versionado com os XSD do status do serviço (resources/fiscal/schemas/nfe). */
export const STATUS_SCHEMA_PACKAGE = 'nfe/4.00-status-pl009q';

export interface StatusQuery {
  /** 1 = Produção, 2 = Homologação (tpAmb). Este cliente só é usado com 2. */
  readonly tpAmb: '1' | '2';
  /** Código IBGE da UF consultada (2 dígitos). A regra K02 recusa UF não atendida pelo webservice. */
  readonly cUF: string;
}

export interface ServiceStatus {
  readonly tpAmb: string;
  readonly verAplic: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly cUF: string;
  readonly dhRecbto: string;
  readonly tMed?: string;
  readonly dhRetorno?: string;
  readonly xObs?: string;
}

export type StatusResult = { readonly kind: 'STATUS'; readonly status: ServiceStatus; readonly responseXml: string } | SefazFailure;

const RETURN = { schemaPackage: STATUS_SCHEMA_PACKAGE, returnElement: 'retConsStatServ', returnSchema: 'retConsStatServ_v4.00.xsd' } as const;

export function buildConsStatServ(query: StatusQuery): string {
  if (!/^[0-9]{2}$/.test(query.cUF)) throw new Error('cUF: 2 dígitos');
  return `<consStatServ xmlns="${NFE_NS}" versao="4.00"><tpAmb>${query.tpAmb}</tpAmb><cUF>${query.cUF}</cUF><xServ>STATUS</xServ></consStatServ>`;
}

/** Lê a resposta SOAP do status (Fault, ou `retConsStatServ` validado no XSD). */
export async function readStatusResponse(responseXml: string, catalog: FiscalSchemaCatalog): Promise<StatusResult> {
  return toStatus(await readSefazResponse(responseXml, { catalog, ...RETURN }));
}

export async function queryServiceStatus(input: { agent: Agent; url: string; query: StatusQuery; catalog: FiscalSchemaCatalog }): Promise<StatusResult> {
  return toStatus(await callSefaz({ ...input, payload: buildConsStatServ(input.query), requestSchema: 'consStatServ_v4.00.xsd', ...RETURN }));
}

function toStatus(result: Awaited<ReturnType<typeof readSefazResponse>>): StatusResult {
  if (result.kind !== 'RETURN') return result;
  const ret = result.element;
  const optional = (name: string) => {
    const value = childText(ret, name);
    return value === undefined ? {} : { [name]: value };
  };
  return {
    kind: 'STATUS',
    responseXml: result.responseXml,
    status: {
      tpAmb: childText(ret, 'tpAmb') ?? '',
      verAplic: childText(ret, 'verAplic') ?? '',
      cStat: childText(ret, 'cStat') ?? '',
      xMotivo: childText(ret, 'xMotivo') ?? '',
      cUF: childText(ret, 'cUF') ?? '',
      dhRecbto: childText(ret, 'dhRecbto') ?? '',
      ...optional('tMed'),
      ...optional('dhRetorno'),
      ...optional('xObs'),
    },
  };
}
