import type { KeyObject } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

/**
 * Assinatura XMLDSig enveloped de um elemento identificado por atributo `Id`.
 * Os algoritmos NÃO têm padrão: cada leiaute oficial define os seus (ADR-0014) e eles
 * serão fixados a partir do manual vigente de cada modalidade.
 */
export const ALGORITHMS = {
  c14n10: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  envelopedSignature: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
} as const;

export interface SignatureProfile {
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
  readonly canonicalizationAlgorithm: string;
  readonly transforms: readonly string[];
}

export interface SignInput {
  readonly xml: string;
  /** Nome local do elemento assinado (ex.: infDPS, infNFe). */
  readonly elementLocalName: string;
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
  readonly profile: SignatureProfile;
}

export function signEnveloped(input: SignInput): string {
  const sig = new SignedXml({
    privateKey: input.privateKey,
    publicCert: input.certificatePem,
    signatureAlgorithm: input.profile.signatureAlgorithm,
    canonicalizationAlgorithm: input.profile.canonicalizationAlgorithm,
  });
  sig.addReference({
    xpath: `//*[local-name()='${input.elementLocalName}']`,
    digestAlgorithm: input.profile.digestAlgorithm,
    transforms: [...input.profile.transforms],
  });
  sig.computeSignature(input.xml, {
    location: { reference: `//*[local-name()='${input.elementLocalName}']`, action: 'after' },
  });
  return sig.getSignedXml();
}

/** Verificação com xml-crypto (a verificação independente é feita com xmlsec1 nos testes). */
export function verifyEnveloped(signedXml: string, certificatePem: string): boolean {
  const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
  const signatures = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  const signature = signatures.item(0);
  if (signatures.length !== 1 || signature === null) return false;
  const verifier = new SignedXml({ publicCert: certificatePem });
  verifier.loadSignature(signature);
  try {
    return verifier.checkSignature(signedXml);
  } catch {
    return false;
  }
}
