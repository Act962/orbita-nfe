import { DOMParser, type Document } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';

/**
 * Validação XSD com libxml2 compilado para WebAssembly: sem binding nativo (sem node-gyp,
 * portátil para Linux, Windows e o futuro agente Tauri) e sem acesso a rede ou disco —
 * o xmllint só enxerga os arquivos passados em memória.
 */
export interface SchemaBundle {
  /** Nome do schema principal dentro do pacote. */
  readonly main: string;
  readonly files: ReadonlyArray<{ fileName: string; contents: string }>;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<{ message: string; line: number | null }>;
}

export async function validateAgainstSchema(xml: string, bundle: SchemaBundle): Promise<SchemaValidationResult> {
  const main = bundle.files.find((f) => f.fileName === bundle.main);
  if (!main) throw new Error(`Schema principal ${bundle.main} ausente do pacote`);
  const result = await validateXML({
    xml: [{ fileName: 'documento.xml', contents: xml }],
    schema: [main],
    preload: bundle.files.filter((f) => f.fileName !== bundle.main),
  });
  return {
    valid: result.valid,
    errors: result.errors.map((e) => ({ message: e.message, line: e.loc?.lineNumber ?? null })),
  };
}

export class UntrustedXmlError extends Error {
  constructor(readonly code: 'XML_DOCTYPE_FORBIDDEN' | 'XML_TOO_LARGE' | 'XML_MALFORMED') {
    super(code);
    this.name = 'UntrustedXmlError';
  }
}

/**
 * Parser para XML NÃO confiável (respostas de autorizadores, XML enviado por clientes).
 * Proteção XXE / "billion laughs": qualquer DOCTYPE é recusado antes do parse; os leiautes
 * fiscais não usam DTD.
 */
export function parseUntrustedXml(xml: string, maxBytes = 5 * 1024 * 1024): Document {
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) throw new UntrustedXmlError('XML_TOO_LARGE');
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new UntrustedXmlError('XML_DOCTYPE_FORBIDDEN');
  const parseErrors: string[] = [];
  let doc: unknown;
  try {
    doc = new DOMParser({
      onError: (level) => {
        if (level !== 'warning') parseErrors.push(level);
      },
    }).parseFromString(xml, 'text/xml');
  } catch {
    // xmldom 0.9 lança ParseError em erro fatal (achado do spike).
    throw new UntrustedXmlError('XML_MALFORMED');
  }
  if (parseErrors.length > 0) throw new UntrustedXmlError('XML_MALFORMED');
  return doc as Document;
}
