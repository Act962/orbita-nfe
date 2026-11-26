import type { Agent } from 'undici';
import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { callSefaz, childElement, childText, NFE_NS, readSefazResponse, serialize, type SefazFailure } from './sefaz-soap.js';

/**
 * Autorização da NFC-e (`NfeAutorizacao4`), sempre síncrona e com UMA nota por lote (ADR-0070).
 *
 * Fontes:
 * - MOC 7.0, Visão Geral, item 5.1: leiaute do `enviNFe` (AP01–AP04) e do `retEnviNFe` (AR01–AR11,
 *   `protNFe` só com cStat 104 "Lote processado"); item 5.1.4.3: processamento síncrono só com
 *   uma nota no lote; item 5.1.6: rejeição não grava, autorização e denegação gravam a nota;
 * - NT 2023.002 v1.02: a NFC-e só aceita lote de uma nota (cStat 126) e só síncrono (cStat 129);
 * - MOC 7.0, Anexo I, tabelas 4.4.1 (100, 104, 110, 150), 4.4.2 (204, 205, 539) e 4.4.3 (301–303);
 * - schemas `enviNFe_v4.00.xsd`/`retEnviNFe_v4.00.xsd` do PL_009q, compostos com o leiaute do
 *   PL_010h no pacote `nfe/4.00-nfe-pl010h` (ADR-0062);
 * - endereço da relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS).
 *
 * Regra de ouro (ADR-0029): só uma resposta que PROVA o resultado vira estado final. Falha de
 * transporte, resposta assíncrona, protocolo de outra chave ou com outro digest não provam nada e
 * viram `UNCERTAIN`, resolvido depois pela consulta da chave (ADR-0064), nunca por reenvio cego.
 */
export const SVRS_NFCE_AUTHORIZATION = {
  HOMOLOGATION: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
} as const;

export const AUTHORIZATION_SCHEMA_PACKAGE = 'nfe/4.00-nfe-pl010h';

export type AuthorizationOutcome =
  /** 100 ou 150 com `protNFe` da nossa chave e do nosso digest: a nota existe e vale. */
  | { readonly kind: 'AUTHORIZED'; readonly cStat: '100' | '150'; readonly nProt: string; readonly authorizedAt: string; readonly protocolXml: string; readonly xMotivo: string }
  /** 110, 301, 302 ou 303: a nota foi GRAVADA como denegada; o número está consumido. */
  | { readonly kind: 'DENIED'; readonly cStat: string; readonly nProt?: string; readonly protocolXml: string; readonly xMotivo: string }
  /** Rejeição: a nota não foi gravada e pode ser corrigida (MOC 5.1.6). */
  | { readonly kind: 'REJECTED'; readonly cStat: string; readonly xMotivo: string; readonly level: 'BATCH' | 'INVOICE' }
  /**
   * 204/205 (a chave já existe) ou 539 (o número já existe com outra chave). Não é rejeição desta
   * nota: precisa da consulta pela chave antes de qualquer conclusão.
   */
  | { readonly kind: 'ALREADY_EXISTS'; readonly cStat: '204' | '205' | '539'; readonly xMotivo: string }
  /** A resposta não prova o resultado. A nota PODE ter sido autorizada: consultar pela chave. */
  | { readonly kind: 'UNCERTAIN'; readonly reason: string };

export type AuthorizationResult = { readonly kind: 'OUTCOME'; readonly outcome: AuthorizationOutcome; readonly responseXml: string } | SefazFailure;

const RETURN = { schemaPackage: AUTHORIZATION_SCHEMA_PACKAGE, returnElement: 'retEnviNFe', returnSchema: 'retEnviNFe_v4.00.xsd' } as const;
const DENIED = new Set(['110', '301', '302', '303']);

/** Lote com UMA NFe já assinada e completa (com `infNFeSupl`), sempre síncrono (`indSinc=1`). */
export function buildEnviNFe(input: { readonly batchId: string; readonly signedNfeXml: string }): string {
  // AP03 idLote: TIdLote, 1 a 15 dígitos, controlado pelo contribuinte.
  if (!/^[0-9]{1,15}$/.test(input.batchId)) throw new Error('idLote: 1 a 15 dígitos');
  const nfe = input.signedNfeXml.replace(/^<\?xml[^>]*\?>\s*/, '');
  if (!nfe.startsWith('<NFe') || (nfe.match(/<NFe[\s>]/g) ?? []).length !== 1) throw new Error('o lote da NFC-e leva exatamente uma NFe');
  return `<enviNFe xmlns="${NFE_NS}" versao="4.00"><idLote>${input.batchId}</idLote><indSinc>1</indSinc>${nfe}</enviNFe>`;
}

export interface ExpectedInvoice {
  readonly accessKey: string;
  /** DigestValue da assinatura da NFe enviada (base64), para conferir o `digVal` do protocolo. */
  readonly digestValue: string;
}

export async function readAuthorizationResponse(responseXml: string, catalog: FiscalSchemaCatalog, expected: ExpectedInvoice): Promise<AuthorizationResult> {
  return toOutcome(await readSefazResponse(responseXml, { catalog, ...RETURN }), expected);
}

export async function authorize(input: {
  readonly agent: Agent;
  readonly url: string;
  readonly batchId: string;
  readonly signedNfeXml: string;
  readonly expected: ExpectedInvoice;
  readonly catalog: FiscalSchemaCatalog;
}): Promise<AuthorizationResult> {
  const payload = buildEnviNFe({ batchId: input.batchId, signedNfeXml: input.signedNfeXml });
  return toOutcome(await callSefaz({ agent: input.agent, url: input.url, payload, catalog: input.catalog, requestSchema: 'enviNFe_v4.00.xsd', ...RETURN }), input.expected);
}

function toOutcome(result: Awaited<ReturnType<typeof readSefazResponse>>, expected: ExpectedInvoice): AuthorizationResult {
  if (result.kind !== 'RETURN') return result;
  return { kind: 'OUTCOME', outcome: outcomeOf(result.element, expected), responseXml: result.responseXml };
}

function outcomeOf(ret: Parameters<typeof childElement>[0], expected: ExpectedInvoice): AuthorizationOutcome {
  const batchStat = childText(ret, 'cStat') ?? '';
  const batchMotivo = childText(ret, 'xMotivo') ?? '';
  const prot = childElement(ret, 'protNFe');

  if (batchStat !== '104') {
    // 103 + infRec: a SEFAZ processou de forma assíncrona. A nota pode sair autorizada depois.
    if (childElement(ret, 'infRec') !== undefined || batchStat === '103' || batchStat === '105') {
      return { kind: 'UNCERTAIN', reason: `LOTE_ASSINCRONO_${batchStat}` };
    }
    // Sem "lote processado" não há protocolo: o lote inteiro foi recusado (ex.: 225 schema).
    return { kind: 'REJECTED', cStat: batchStat, xMotivo: batchMotivo, level: 'BATCH' };
  }

  const infProt = prot === undefined ? undefined : childElement(prot, 'infProt');
  if (prot === undefined || infProt === undefined) return { kind: 'UNCERTAIN', reason: 'LOTE_PROCESSADO_SEM_PROTOCOLO' };
  const chNFe = childText(infProt, 'chNFe');
  if (chNFe !== expected.accessKey) return { kind: 'UNCERTAIN', reason: 'PROTOCOLO_DE_OUTRA_CHAVE' };

  const cStat = childText(infProt, 'cStat') ?? '';
  const xMotivo = childText(infProt, 'xMotivo') ?? '';
  const nProt = childText(infProt, 'nProt');
  const digVal = childText(infProt, 'digVal');
  const protocolXml = serialize(prot);

  if (cStat === '100' || cStat === '150') {
    // PR10: o digVal confere a integridade da nota que a SEFAZ gravou com a que enviamos.
    if (digVal !== expected.digestValue) return { kind: 'UNCERTAIN', reason: 'DIGEST_DIFERENTE' };
    if (nProt === undefined) return { kind: 'UNCERTAIN', reason: 'AUTORIZADA_SEM_NPROT' };
    return { kind: 'AUTHORIZED', cStat, nProt, authorizedAt: childText(infProt, 'dhRecbto') ?? '', protocolXml, xMotivo };
  }
  if (DENIED.has(cStat)) return { kind: 'DENIED', cStat, ...(nProt === undefined ? {} : { nProt }), protocolXml, xMotivo };
  if (cStat === '204' || cStat === '205' || cStat === '539') return { kind: 'ALREADY_EXISTS', cStat, xMotivo };
  return { kind: 'REJECTED', cStat, xMotivo, level: 'INVOICE' };
}
