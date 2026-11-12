import { describe, expect, it } from 'vitest';
import { parseUntrustedXml, UntrustedXmlError } from './untrusted-xml.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof UntrustedXmlError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('parseUntrustedXml', () => {
  it('aceita uma resposta normal', () => {
    const doc = parseUntrustedXml('<retorno><cStat>100</cStat></retorno>');
    expect(doc.getElementsByTagName('cStat').item(0)?.textContent).toBe('100');
  });

  it.each([
    ['XXE externo', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'],
    ['billion laughs', '<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>'],
    ['doctype minúsculo', '<!doctype r><r/>'],
    ['entidade sem doctype', '<r><!ENTITY x "y"></r>'],
  ])('recusa %s', (_name, xml) => {
    expect(codeOf(() => parseUntrustedXml(xml))).toBe('XML_DOCTYPE_FORBIDDEN');
  });

  it.each(['<a><b></a>', '', 'texto solto', '<a>'])('recusa XML malformado: %j', (xml) => {
    expect(codeOf(() => parseUntrustedXml(xml))).toBe('XML_MALFORMED');
  });

  it('recusa acima do limite, contando bytes e não caracteres', () => {
    expect(codeOf(() => parseUntrustedXml(`<a>${'x'.repeat(2000)}</a>`, 1000))).toBe('XML_TOO_LARGE');
    // 400 "ç" = 800 bytes em UTF-8.
    expect(codeOf(() => parseUntrustedXml(`<a>${'ç'.repeat(400)}</a>`, 600))).toBe('XML_TOO_LARGE');
  });

  it('a mensagem do erro é só o código, sem trecho do documento', () => {
    try {
      parseUntrustedXml('<a>CPF 12345678909<b></a>');
    } catch (error) {
      expect((error as Error).message).toBe('XML_MALFORMED');
    }
  });
});
