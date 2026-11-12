import { DOMParser, type Document } from '@xmldom/xmldom';

/** Limite padrão para XML recebido de fora (respostas de autorizadores, XML enviado por clientes). */
export const DEFAULT_MAX_XML_BYTES = 5 * 1024 * 1024;

export type UntrustedXmlErrorCode = 'XML_DOCTYPE_FORBIDDEN' | 'XML_TOO_LARGE' | 'XML_MALFORMED';

export class UntrustedXmlError extends Error {
  constructor(readonly code: UntrustedXmlErrorCode) {
    super(code);
    this.name = 'UntrustedXmlError';
  }
}

/**
 * Parser para XML NÃO confiável (ADR-0014, spike 03).
 *
 * - Qualquer `DOCTYPE`/`ENTITY` é recusado antes do parse (XXE e "billion laughs"):
 *   os leiautes fiscais não usam DTD.
 * - O tamanho é conferido antes de qualquer processamento.
 * - O xmldom 0.9 lança `ParseError` em erro fatal e também chama `onError`: os dois caminhos
 *   viram `XML_MALFORMED`.
 *
 * A mensagem do erro é só o código: nunca inclui trechos do documento, que pode conter dados
 * pessoais.
 */
export function parseUntrustedXml(xml: string, maxBytes = DEFAULT_MAX_XML_BYTES): Document {
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) throw new UntrustedXmlError('XML_TOO_LARGE');
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new UntrustedXmlError('XML_DOCTYPE_FORBIDDEN');
  const parseErrors: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level) => {
        if (level !== 'warning') parseErrors.push(level);
      },
    }).parseFromString(xml, 'text/xml');
  } catch {
    throw new UntrustedXmlError('XML_MALFORMED');
  }
  if (parseErrors.length > 0 || doc.documentElement === null) throw new UntrustedXmlError('XML_MALFORMED');
  return doc;
}
