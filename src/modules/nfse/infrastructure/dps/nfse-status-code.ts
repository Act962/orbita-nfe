import { parseUntrustedXml } from '../../../../shared/infrastructure/xml/untrusted-xml.js';

const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

/**
 * `cStat` do grupo `infNFSe` do XML devolvido pelo autorizador (ADR-0054; XSD `TCInfNFSe`).
 *
 * Informativo: o XML já foi aceito pelo caminho da autorização. XML sem o grupo, ilegível ou com um
 * valor fora do formato devolve `null`, sem impedir a autorização.
 */
export function nfseStatusCode(nfseXml: string): string | null {
  let doc: ReturnType<typeof parseUntrustedXml>;
  try {
    doc = parseUntrustedXml(nfseXml);
  } catch {
    return null;
  }
  const info = doc.getElementsByTagNameNS(NFSE_NS, 'infNFSe').item(0);
  if (info === null) return null;
  for (let child = info.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === child.ELEMENT_NODE && child.localName === 'cStat' && child.namespaceURI === NFSE_NS) {
      const value = (child.textContent ?? '').trim();
      return /^\d{3}$/.test(value) ? value : null;
    }
  }
  return null;
}
