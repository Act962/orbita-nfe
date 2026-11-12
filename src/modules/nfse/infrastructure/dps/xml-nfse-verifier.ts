import type { Element } from '@xmldom/xmldom';
import { SchemaCatalogError, type FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { parseUntrustedXml, UntrustedXmlError } from '../../../../shared/infrastructure/xml/untrusted-xml.js';
import { XMLDSIG_NS } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { NfseDocumentVerifier, NfseVerification } from '../../application/ports.js';
import { tpAmbOf } from '../../domain/dps.js';
import { NFSE_NS } from './dps-xml.js';

const ROOT_SCHEMA = 'NFSe_v1.01.xsd';

/**
 * Conferência do XML oficial da NFS-e trazido pelo operador na resolução manual (ADR-0034 item 3).
 *
 * Estrutura conferida contra o XSD oficial (`NFSe_v1.01.xsd`, tipo TCNFSe) do MESMO pacote em
 * que a DPS foi validada e assinada (`layout_package` do documento):
 * - `infNFSe/@Id` = "NFS" + 50 dígitos (TSIdNFSe) → a chave de acesso são os 50 dígitos (TSChaveNFSe);
 * - `infNFSe/DPS/infDPS/@Id` igual ao Id da DPS deste documento;
 * - `infDPS/tpAmb` igual ao ambiente do documento (TSTipoAmbiente);
 * - `infNFSe/dhProc` (TSDateTimeUTC) vira a data da autorização;
 * - se a DPS embutida trouxer assinatura, o `SignatureValue` tem de ser o da DPS que NÓS
 *   assinamos: outra DPS com o mesmo Id (ex.: emitida por outro sistema) é recusada.
 *
 * NÃO conferido (limitação registrada no ADR-0034): a assinatura da SEFIN sobre `infNFSe`. A
 * cadeia de confiança do certificado do emissor nacional ainda não está definida.
 *
 * Os códigos de recusa são estáveis e não citam o conteúdo do XML (pode ter dados pessoais).
 */
export class XmlNfseVerifier implements NfseDocumentVerifier {
  constructor(private readonly catalog: FiscalSchemaCatalog) {}

  async verify(
    nfseXml: string,
    expected: { dpsId: string; environment: 'PRODUCTION' | 'HOMOLOGATION'; layoutPackage: string | null; signedDps: string | undefined },
  ): Promise<NfseVerification> {
    let root: Element;
    try {
      root = parseUntrustedXml(nfseXml).documentElement as Element;
    } catch (error) {
      if (error instanceof UntrustedXmlError) return fail(`NFSE_${error.code}`);
      throw error;
    }
    if (root.localName !== 'NFSe' || root.namespaceURI !== NFSE_NS) return fail('NFSE_XML_NOT_NFSE');
    if (expected.layoutPackage === null) return fail('NFSE_LAYOUT_UNKNOWN');
    if (expected.signedDps === undefined) return fail('SIGNED_DPS_MISSING');

    let valid: boolean;
    try {
      valid = (await this.catalog.validate(expected.layoutPackage, ROOT_SCHEMA, nfseXml)).valid;
    } catch (error) {
      if (error instanceof SchemaCatalogError) return fail('NFSE_LAYOUT_UNKNOWN');
      throw error;
    }
    if (!valid) return fail('NFSE_SCHEMA_INVALID');

    // A partir daqui a estrutura é a do XSD: os elementos obrigatórios existem.
    const inf = child(root, NFSE_NS, 'infNFSe');
    const dps = inf === undefined ? undefined : child(inf, NFSE_NS, 'DPS');
    const infDps = dps === undefined ? undefined : child(dps, NFSE_NS, 'infDPS');
    const id = inf?.getAttribute('Id') ?? '';
    const processedAt = new Date(textOf(inf, 'dhProc'));
    if (inf === undefined || dps === undefined || infDps === undefined || !/^NFS[0-9]{50}$/.test(id) || Number.isNaN(processedAt.getTime())) {
      return fail('NFSE_SCHEMA_INVALID');
    }
    if (infDps.getAttribute('Id') !== expected.dpsId) return fail('NFSE_DPS_MISMATCH');
    if (textOf(infDps, 'tpAmb') !== tpAmbOf(expected.environment)) return fail('NFSE_ENVIRONMENT_MISMATCH');

    const embedded = signatureValue(dps);
    if (embedded !== undefined) {
      let ours: string | undefined;
      try {
        ours = signatureValue(parseUntrustedXml(expected.signedDps).documentElement as Element);
      } catch {
        ours = undefined;
      }
      if (ours !== embedded) return fail('NFSE_DPS_SIGNATURE_MISMATCH');
    }
    return { ok: true, accessKey: id.slice(3), processedAt, dpsSignature: embedded === undefined ? 'ABSENT' : 'MATCH' };
  }
}

const fail = (code: string): NfseVerification => ({ ok: false, code });

function child(parent: Element, namespace: string, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.localName === localName && element.namespaceURI === namespace) return element;
    }
  }
  return undefined;
}

function textOf(parent: Element | undefined, localName: string): string {
  return (parent === undefined ? undefined : child(parent, NFSE_NS, localName))?.textContent?.trim() ?? '';
}

/** `SignatureValue` da assinatura filha direta de `element`, sem espaços (base64 pode quebrar linha). */
function signatureValue(element: Element): string | undefined {
  const signature = child(element, XMLDSIG_NS, 'Signature');
  const value = signature === undefined ? undefined : child(signature, XMLDSIG_NS, 'SignatureValue');
  return value?.textContent?.replace(/\s+/g, '') ?? undefined;
}
