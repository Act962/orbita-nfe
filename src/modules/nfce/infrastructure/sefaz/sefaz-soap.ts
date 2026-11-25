import { XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import type { Agent } from 'undici';
import { sendOnce, type TransportOutcome } from '../../../../shared/infrastructure/transport/mtls-transport.js';
import { parseUntrustedXml, UntrustedXmlError } from '../../../../shared/infrastructure/xml/untrusted-xml.js';
import type { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';

/**
 * Chamada SOAP aos webservices da NF-e/NFC-e 4.00 (ADR-0063, ADR-0064).
 *
 * Fontes: MOC 7.0, Visão Geral, item 4.4 (SOAP 1.2, Document/Literal, XML no parâmetro
 * `nfeDadosMsg`; na versão 4.0 o SOAP Header `nfeCabecMsg` foi eliminado). Namespace e ação SOAP
 * de cada serviço são lidos do WSDL publicado pelo próprio serviço, nunca escritos à mão.
 */
export const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const SOAP12_ENV = 'http://www.w3.org/2003/05/soap-envelope';
const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const WSDL_SOAP12_NS = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const DATA_ELEMENT = 'nfeDadosMsg';
const LIMITS = { maxResponseBytes: 512 * 1024 } as const;

export interface WsdlContract {
  readonly targetNamespace: string;
  readonly soapAction: string;
}

/** Falhas comuns a qualquer serviço; o sucesso (`kind` próprio) é de cada serviço. */
export type SefazFailure =
  | { readonly kind: 'SOAP_FAULT'; readonly code: string; readonly reason: string; readonly responseXml: string }
  | { readonly kind: 'HTTP_ERROR'; readonly step: 'wsdl' | 'request'; readonly httpStatus: number }
  | { readonly kind: 'TRANSPORT'; readonly step: 'wsdl' | 'request'; readonly outcome: Exclude<TransportOutcome, { kind: 'RESPONSE' }> }
  | { readonly kind: 'INVALID'; readonly step: 'request' | 'wsdl' | 'response'; readonly reason: string; readonly responseXml?: string };

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

export interface SefazReturn {
  readonly kind: 'RETURN';
  /** Elemento de retorno (ex.: `retConsStatServ`), já validado no XSD. */
  readonly element: Element;
  readonly responseXml: string;
}

/** Lê a resposta SOAP: Fault, ou o elemento `returnElement` validado no XSD `returnSchema`. */
export async function readSefazResponse(
  responseXml: string,
  expect: { catalog: FiscalSchemaCatalog; schemaPackage: string; returnElement: string; returnSchema: string },
): Promise<SefazReturn | SefazFailure> {
  let doc: Document;
  try {
    doc = parseUntrustedXml(responseXml);
  } catch (error) {
    return { kind: 'INVALID', step: 'response', reason: error instanceof UntrustedXmlError ? error.code : 'XML_MALFORMED', responseXml };
  }
  const fault = doc.getElementsByTagNameNS(SOAP12_ENV, 'Fault')[0];
  if (fault !== undefined) {
    return { kind: 'SOAP_FAULT', code: textOf(fault.getElementsByTagNameNS(SOAP12_ENV, 'Value')[0]), reason: textOf(fault.getElementsByTagNameNS(SOAP12_ENV, 'Text')[0]), responseXml };
  }
  const element = doc.getElementsByTagNameNS(NFE_NS, expect.returnElement)[0];
  if (element === undefined) return { kind: 'INVALID', step: 'response', reason: `SEM_${expect.returnElement}`, responseXml };
  const valid = await expect.catalog.validate(expect.schemaPackage, expect.returnSchema, new XMLSerializer().serializeToString(element));
  if (!valid.valid) return { kind: 'INVALID', step: 'response', reason: `${expect.returnElement} fora do XSD`, responseXml };
  return { kind: 'RETURN', element, responseXml };
}

/**
 * Valida a mensagem no XSD, lê o WSDL (mesmo certificado), monta o envelope e envia UMA vez.
 * Nada de retentativa automática: repetir é decisão de quem chama.
 */
export async function callSefaz(input: {
  agent: Agent;
  url: string;
  payload: string;
  catalog: FiscalSchemaCatalog;
  schemaPackage: string;
  requestSchema: string;
  returnElement: string;
  returnSchema: string;
}): Promise<SefazReturn | SefazFailure> {
  const requestValid = await input.catalog.validate(input.schemaPackage, input.requestSchema, input.payload);
  if (!requestValid.valid) return { kind: 'INVALID', step: 'request', reason: `${input.requestSchema}: mensagem fora do XSD` };

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
      body: buildSoapEnvelope(contract, input.payload),
    },
    LIMITS,
  );
  if (response.kind !== 'RESPONSE') return { kind: 'TRANSPORT', step: 'request', outcome: response };
  // SOAP 1.2 devolve Fault com HTTP 500: lê o corpo antes de desistir pelo código HTTP.
  const result = await readSefazResponse(response.body, input);
  if (result.kind === 'INVALID' && response.status !== 200) return { kind: 'HTTP_ERROR', step: 'request', httpStatus: response.status };
  return result;
}

export function childText(parent: Element, name: string): string | undefined {
  const el = childElement(parent, name);
  return el === undefined ? undefined : textOf(el);
}

/** Filho direto no namespace da NF-e (não desce na árvore: `cStat` do protocolo não confunde o do retorno). */
export function childElement(parent: Element, name: string): Element | undefined {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (el.namespaceURI === NFE_NS && el.localName === name) return el;
  }
  return undefined;
}

export function serialize(element: Element): string {
  return new XMLSerializer().serializeToString(element);
}

function textOf(node: Element | undefined): string {
  return (node?.textContent ?? '').trim();
}
