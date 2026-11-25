import { XMLSerializer, type Element } from '@xmldom/xmldom';
import type { Agent } from 'undici';
import { sendOnce, type TransportOutcome } from '../../../../shared/infrastructure/transport/mtls-transport.js';
import { parseUntrustedXml, UntrustedXmlError } from '../../../../shared/infrastructure/xml/untrusted-xml.js';
import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';

/**
 * Consulta do status do serviço da NFC-e (`NfeStatusServico4`), ADR-0063. Não emite nada.
 *
 * Fontes:
 * - MOC 7.0, Visão Geral, item 4.4 (SOAP 1.2, Document/Literal, XML em `nfeDadosMsg`; na versão
 *   4.0 o SOAP Header `nfeCabecMsg` foi eliminado) e item 5.5 (leiaute e regras K01 a K04);
 * - schemas `consStatServ_v4.00.xsd` e `retConsStatServ_v4.00.xsd` do PL_009q (ADR-0062);
 * - endereço do SVRS na relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS);
 * - namespace e ação SOAP: lidos do WSDL publicado pelo próprio serviço, que exige o mesmo
 *   certificado de cliente. Nada disso é escrito à mão no código.
 */

/** Relação oficial de webservices da NFC-e, SVRS, versão 4.00 (diagnóstico da NFC-e no PI). */
export const SVRS_NFCE_STATUS = {
  HOMOLOGATION: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
} as const;

/** Pacote versionado com os XSD do status do serviço (resources/fiscal/schemas/nfe). */
export const STATUS_SCHEMA_PACKAGE = 'nfe/4.00-status-pl009q';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const SOAP12_ENV = 'http://www.w3.org/2003/05/soap-envelope';
const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const WSDL_SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
/** MOC 7.0, item 4.4: o XML da mensagem vai no parâmetro `nfeDadosMsg`. */
const DATA_ELEMENT = 'nfeDadosMsg';

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

export type StatusResult =
  | { readonly kind: 'STATUS'; readonly status: ServiceStatus; readonly responseXml: string }
  | { readonly kind: 'SOAP_FAULT'; readonly code: string; readonly reason: string; readonly responseXml: string }
  | { readonly kind: 'HTTP_ERROR'; readonly step: 'wsdl' | 'status'; readonly httpStatus: number }
  | { readonly kind: 'TRANSPORT'; readonly step: 'wsdl' | 'status'; readonly outcome: Exclude<TransportOutcome, { kind: 'RESPONSE' }> }
  | { readonly kind: 'INVALID'; readonly step: 'request' | 'wsdl' | 'response'; readonly reason: string; readonly responseXml?: string };

export interface WsdlContract {
  readonly targetNamespace: string;
  readonly soapAction: string;
}

const LIMITS = { maxResponseBytes: 512 * 1024 } as const;

export function buildConsStatServ(query: StatusQuery): string {
  if (!/^[0-9]{2}$/.test(query.cUF)) throw new Error('cUF: 2 dígitos');
  return `<consStatServ xmlns="${NFE_NS}" versao="4.00"><tpAmb>${query.tpAmb}</tpAmb><cUF>${query.cUF}</cUF><xServ>STATUS</xServ></consStatServ>`;
}

/** Envelope SOAP 1.2 sem Header (MOC 7.0, item 4.4.1, versão 4.0). */
export function buildSoapEnvelope(contract: WsdlContract, payload: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap12:Envelope xmlns:soap12="${SOAP12_ENV}"><soap12:Body>` +
    `<${DATA_ELEMENT} xmlns="${contract.targetNamespace}">${payload}</${DATA_ELEMENT}>` +
    '</soap12:Body></soap12:Envelope>'
  );
}

/**
 * Tira do WSDL o namespace e a única ação SOAP 1.2, e confere que a entrada é `nfeDadosMsg`.
 * Qualquer surpresa (zero ou várias operações, outro elemento) vira erro: não adivinhamos.
 */
export function readWsdlContract(wsdl: string): WsdlContract {
  const doc = parseUntrustedXml(wsdl);
  const root = doc.documentElement;
  if (root?.namespaceURI !== WSDL_NS || root.localName !== 'definitions') throw new Error('WSDL_NOT_DEFINITIONS');
  const targetNamespace = root.getAttribute('targetNamespace') ?? '';
  if (!/^http:\/\/www\.portalfiscal\.inf\.br\/nfe\/wsdl\/[A-Za-z0-9]+$/.test(targetNamespace)) throw new Error('WSDL_UNEXPECTED_NAMESPACE');
  const actions = [...new Set(Array.from(doc.getElementsByTagNameNS(WSDL_SOAP12_NS, 'operation')).map((op) => op.getAttribute('soapAction') ?? ''))];
  if (actions.length !== 1 || actions[0] === '') throw new Error('WSDL_SOAP12_OPERATION_NOT_UNIQUE');
  const dataElements = Array.from(doc.getElementsByTagNameNS(XSD_NS, 'element')).filter((e) => e.getAttribute('name') === DATA_ELEMENT);
  if (dataElements.length === 0) throw new Error('WSDL_WITHOUT_NFEDADOSMSG');
  return { targetNamespace, soapAction: actions[0] as string };
}

/** Lê a resposta SOAP: Fault ou `retConsStatServ` (validado no XSD oficial). */
export async function readStatusResponse(responseXml: string, catalog: FiscalSchemaCatalog): Promise<StatusResult> {
  let doc;
  try {
    doc = parseUntrustedXml(responseXml);
  } catch (error) {
    return { kind: 'INVALID', step: 'response', reason: error instanceof UntrustedXmlError ? error.code : 'XML_MALFORMED', responseXml };
  }
  const fault = doc.getElementsByTagNameNS(SOAP12_ENV, 'Fault')[0];
  if (fault !== undefined) {
    const code = textOf(fault.getElementsByTagNameNS(SOAP12_ENV, 'Value')[0]);
    const reason = textOf(fault.getElementsByTagNameNS(SOAP12_ENV, 'Text')[0]);
    return { kind: 'SOAP_FAULT', code, reason, responseXml };
  }
  const ret = doc.getElementsByTagNameNS(NFE_NS, 'retConsStatServ')[0];
  if (ret === undefined) return { kind: 'INVALID', step: 'response', reason: 'SEM_retConsStatServ', responseXml };
  const retXml = new XMLSerializer().serializeToString(ret);
  const valid = await catalog.validate(STATUS_SCHEMA_PACKAGE, 'retConsStatServ_v4.00.xsd', retXml);
  if (!valid.valid) return { kind: 'INVALID', step: 'response', reason: 'retConsStatServ fora do XSD', responseXml };
  const field = (name: string) => {
    const node = ret.getElementsByTagNameNS(NFE_NS, name)[0];
    return node === undefined ? undefined : textOf(node);
  };
  const required = (name: string) => field(name) ?? '';
  const optional = (name: string) => {
    const value = field(name);
    return value === undefined ? {} : { [name]: value };
  };
  return {
    kind: 'STATUS',
    responseXml,
    status: {
      tpAmb: required('tpAmb'),
      verAplic: required('verAplic'),
      cStat: required('cStat'),
      xMotivo: required('xMotivo'),
      cUF: required('cUF'),
      dhRecbto: required('dhRecbto'),
      ...optional('tMed'),
      ...optional('dhRetorno'),
      ...optional('xObs'),
    },
  };
}

/**
 * Consulta o status: lê o WSDL (mesmo certificado), monta o envelope, valida a entrada no XSD e
 * envia UMA vez. Consulta de status não cria documento fiscal, mas a regra continua: nada de
 * retentativa automática.
 */
export async function queryServiceStatus(input: { agent: Agent; url: string; query: StatusQuery; catalog: FiscalSchemaCatalog }): Promise<StatusResult> {
  const payload = buildConsStatServ(input.query);
  const requestValid = await input.catalog.validate(STATUS_SCHEMA_PACKAGE, 'consStatServ_v4.00.xsd', payload);
  if (!requestValid.valid) return { kind: 'INVALID', step: 'request', reason: 'consStatServ fora do XSD' };

  const wsdl = await sendOnce(input.agent, { method: 'GET', url: `${input.url}?wsdl` }, LIMITS);
  if (wsdl.kind !== 'RESPONSE') return { kind: 'TRANSPORT', step: 'wsdl', outcome: wsdl };
  if (wsdl.status !== 200) return { kind: 'HTTP_ERROR', step: 'wsdl', httpStatus: wsdl.status };
  let contract: WsdlContract;
  try {
    contract = readWsdlContract(wsdl.body);
  } catch (error) {
    return { kind: 'INVALID', step: 'wsdl', reason: error instanceof Error ? error.message : 'WSDL_INVALIDO' };
  }

  const response = await sendOnce(
    input.agent,
    {
      method: 'POST',
      url: input.url,
      // SOAP 1.2: a ação vai no parâmetro `action` do Content-Type.
      headers: { 'content-type': `application/soap+xml; charset=utf-8; action="${contract.soapAction}"` },
      body: buildSoapEnvelope(contract, payload),
    },
    LIMITS,
  );
  if (response.kind !== 'RESPONSE') return { kind: 'TRANSPORT', step: 'status', outcome: response };
  // SOAP 1.2 devolve Fault com HTTP 500: lê o corpo antes de desistir pelo código HTTP.
  const result = await readStatusResponse(response.body, input.catalog);
  if (result.kind === 'INVALID' && response.status !== 200) return { kind: 'HTTP_ERROR', step: 'status', httpStatus: response.status };
  return result;
}

function textOf(node: Element | undefined): string {
  return (node?.textContent ?? '').trim();
}
