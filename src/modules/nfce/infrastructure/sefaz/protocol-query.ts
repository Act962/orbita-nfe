import type { Agent } from 'undici';
import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { callSefaz, childElement, childText, NFE_NS, readSefazResponse, serialize, type SefazFailure } from './sefaz-soap.js';

/**
 * Consulta da situação da NFC-e pela chave de acesso (`NfeConsultaProtocolo4`), ADR-0064.
 * Não emite nada. É a base da recuperação de resposta perdida: com a autorização só síncrona
 * (NT 2023.002), o que ficou em dúvida se resolve consultando a chave, nunca reenviando às cegas.
 *
 * Fontes:
 * - MOC 7.0, Visão Geral, item 5.4: leiaute (EP01–EP05, ER01–ER10), "protNFe" quando cStat 100,
 *   150 ou 110; "retCancNFe" quando 101 ou 151; regra J03, 217 "NF-e não consta na base de dados
 *   da SEFAZ"; regras J01–J02k de chave e ambiente;
 * - schemas `consSitNFe_v4.00.xsd` e `retConsSitNFe_v4.00.xsd` do PL_010d v1.03 (CNPJ alfanumérico);
 * - endereço do SVRS na relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS).
 */
export const SVRS_NFCE_PROTOCOL_QUERY = {
  HOMOLOGATION: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
} as const;

export const PROTOCOL_SCHEMA_PACKAGE = 'nfe/4.00-conssit-pl010d';

/** Situação lida do `cStat` do retorno (MOC 7.0, item 5.4.2 e regra J03). */
export type ProtocolSituation =
  | { readonly kind: 'AUTHORIZED'; readonly cStat: '100' | '150'; readonly protocolXml: string; readonly nProt?: string; readonly authorizedAt?: string }
  | { readonly kind: 'DENIED'; readonly cStat: '110'; readonly protocolXml: string; readonly nProt?: string }
  | { readonly kind: 'CANCELLED'; readonly cStat: '101' | '151'; readonly cancellationXml?: string }
  | { readonly kind: 'NOT_FOUND'; readonly cStat: '217' }
  /** Qualquer outro cStat: a consulta foi recusada (chave inválida, UF errada, etc.). Não é prova de nada. */
  | { readonly kind: 'REFUSED'; readonly cStat: string };

export type ProtocolResult =
  | {
      readonly kind: 'PROTOCOL';
      readonly situation: ProtocolSituation;
      readonly header: { readonly tpAmb: string; readonly verAplic: string; readonly cStat: string; readonly xMotivo: string; readonly cUF: string; readonly dhRecbto: string; readonly chNFe: string };
      readonly responseXml: string;
    }
  | SefazFailure;

const RETURN = { schemaPackage: PROTOCOL_SCHEMA_PACKAGE, returnElement: 'retConsSitNFe', returnSchema: 'retConsSitNFe_v4.00.xsd' } as const;

export function buildConsSitNFe(query: { tpAmb: '1' | '2'; accessKey: string }): string {
  // Formato do TChNFe do PL_010d (CNPJ alfanumérico); o dígito e o resto são da SEFAZ (J02a–J02g).
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(query.accessKey)) throw new Error('chave de acesso: 44 posições no formato TChNFe');
  return `<consSitNFe xmlns="${NFE_NS}" versao="4.00"><tpAmb>${query.tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${query.accessKey}</chNFe></consSitNFe>`;
}

export async function readProtocolResponse(responseXml: string, catalog: FiscalSchemaCatalog): Promise<ProtocolResult> {
  return toProtocol(await readSefazResponse(responseXml, { catalog, ...RETURN }));
}

export async function queryProtocol(input: { agent: Agent; url: string; query: { tpAmb: '1' | '2'; accessKey: string }; catalog: FiscalSchemaCatalog }): Promise<ProtocolResult> {
  return toProtocol(await callSefaz({ ...input, payload: buildConsSitNFe(input.query), requestSchema: 'consSitNFe_v4.00.xsd', ...RETURN }));
}

function toProtocol(result: Awaited<ReturnType<typeof readSefazResponse>>): ProtocolResult {
  if (result.kind !== 'RETURN') return result;
  const ret = result.element;
  const text = (name: string) => childText(ret, name) ?? '';
  const header = { tpAmb: text('tpAmb'), verAplic: text('verAplic'), cStat: text('cStat'), xMotivo: text('xMotivo'), cUF: text('cUF'), dhRecbto: text('dhRecbto'), chNFe: text('chNFe') };
  return { kind: 'PROTOCOL', header, situation: situationOf(header.cStat, ret), responseXml: result.responseXml };
}

function situationOf(cStat: string, ret: Parameters<typeof childElement>[0]): ProtocolSituation {
  const prot = childElement(ret, 'protNFe');
  const infProt = prot === undefined ? undefined : childElement(prot, 'infProt');
  const nProt = infProt === undefined ? undefined : childText(infProt, 'nProt');
  const authorizedAt = infProt === undefined ? undefined : childText(infProt, 'dhRecbto');
  if ((cStat === '100' || cStat === '150') && prot !== undefined) {
    return { kind: 'AUTHORIZED', cStat, protocolXml: serialize(prot), ...(nProt === undefined ? {} : { nProt }), ...(authorizedAt === undefined ? {} : { authorizedAt }) };
  }
  if (cStat === '110' && prot !== undefined) return { kind: 'DENIED', cStat, protocolXml: serialize(prot), ...(nProt === undefined ? {} : { nProt }) };
  if (cStat === '101' || cStat === '151') {
    const canc = childElement(ret, 'retCancNFe');
    return { kind: 'CANCELLED', cStat, ...(canc === undefined ? {} : { cancellationXml: serialize(canc) }) };
  }
  if (cStat === '217') return { kind: 'NOT_FOUND', cStat };
  // 100/150/110 sem protNFe também cai aqui: sem o protocolo, não há prova de autorização.
  return { kind: 'REFUSED', cStat };
}
