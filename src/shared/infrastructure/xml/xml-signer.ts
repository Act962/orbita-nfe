import type { KeyObject } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { parseUntrustedXml } from './untrusted-xml.js';

/**
 * Assinatura XMLDSig enveloped de um elemento identificado por atributo `Id`
 * (ADR-0014; promovida do spike 01, verificada por xmlsec1 no teste de integração).
 *
 * Os algoritmos não têm padrão no código: cada leiaute define o seu perfil, com a fonte
 * documentada (`SIGNATURE_PROFILES`).
 */
export const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

export const ALGORITHMS = {
  c14n10: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  envelopedSignature: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
} as const;

export interface SignatureProfile {
  readonly id: string;
  readonly signatureAlgorithm: string;
  readonly digestAlgorithm: string;
  readonly canonicalizationAlgorithm: string;
  readonly transforms: readonly string[];
}

/**
 * Perfis com fonte (ADR-0014, complemento de 2026-11-10).
 *
 * `nfse-nacional-dps`: Guia API THE V7 (DSF/SEMF, 20/08/2026, §4), que segue o padrão nacional.
 * O Anexo I da SEFIN Nacional exige assinatura válida, mas não lista os algoritmos.
 * **Provisório para a SEFIN** até o primeiro envio aceito na produção restrita.
 * O SHA-1 é exigência do autorizador, não escolha do motor.
 */
export const SIGNATURE_PROFILES = {
  nfseNacionalDps: {
    id: 'nfse-nacional-dps',
    signatureAlgorithm: ALGORITHMS.rsaSha1,
    digestAlgorithm: ALGORITHMS.sha1,
    canonicalizationAlgorithm: ALGORITHMS.c14n10,
    transforms: [ALGORITHMS.envelopedSignature, ALGORITHMS.c14n10],
  },
} as const satisfies Record<string, SignatureProfile>;

export interface SignInput {
  readonly xml: string;
  /** Nome local do elemento assinado (ex.: infDPS). Precisa ter atributo `Id` e ser único. */
  readonly elementLocalName: string;
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
  readonly profile: SignatureProfile;
}

export class XmlSignatureError extends Error {
  constructor(readonly code: 'XML_SIGN_TARGET_NOT_FOUND' | 'XML_SIGN_TARGET_AMBIGUOUS' | 'XML_SIGN_TARGET_WITHOUT_ID' | 'XML_ALREADY_SIGNED') {
    super(code);
    this.name = 'XmlSignatureError';
  }
}

/**
 * Assina e devolve o XML com `<Signature xmlns="…xmldsig#">` (sem prefixo `ds:`) logo depois do
 * elemento assinado, como irmão dele.
 */
export function signEnveloped(input: SignInput): string {
  const doc = parseUntrustedXml(input.xml);
  const targets = Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === input.elementLocalName);
  const [target] = targets;
  if (target === undefined) throw new XmlSignatureError('XML_SIGN_TARGET_NOT_FOUND');
  if (targets.length > 1) throw new XmlSignatureError('XML_SIGN_TARGET_AMBIGUOUS');
  if (!target.getAttribute('Id')) throw new XmlSignatureError('XML_SIGN_TARGET_WITHOUT_ID');
  if (doc.getElementsByTagNameNS(XMLDSIG_NS, 'Signature').length > 0) throw new XmlSignatureError('XML_ALREADY_SIGNED');

  const xpath = `//*[local-name()='${input.elementLocalName}']`;
  const sig = new SignedXml({
    privateKey: input.privateKey,
    publicCert: input.certificatePem,
    signatureAlgorithm: input.profile.signatureAlgorithm,
    canonicalizationAlgorithm: input.profile.canonicalizationAlgorithm,
  });
  sig.addReference({ xpath, digestAlgorithm: input.profile.digestAlgorithm, transforms: [...input.profile.transforms] });
  sig.computeSignature(input.xml, { location: { reference: xpath, action: 'after' } });
  return sig.getSignedXml();
}

export type VerificationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'SIGNATURE_MISSING' | 'SIGNATURE_MULTIPLE' | 'ALGORITHM_NOT_ALLOWED' | 'SIGNATURE_INVALID' | 'XML_REJECTED' };

/**
 * Verifica uma assinatura recebida. Só aceita os algoritmos do perfil (ADR-0014): uma assinatura
 * válida com outro algoritmo é recusada.
 */
export function verifyEnveloped(signedXml: string, certificatePem: string, profile: SignatureProfile): VerificationResult {
  let doc;
  try {
    doc = parseUntrustedXml(signedXml);
  } catch {
    return { valid: false, reason: 'XML_REJECTED' };
  }
  const signatures = doc.getElementsByTagNameNS(XMLDSIG_NS, 'Signature');
  const signature = signatures.item(0);
  if (signature === null) return { valid: false, reason: 'SIGNATURE_MISSING' };
  if (signatures.length > 1) return { valid: false, reason: 'SIGNATURE_MULTIPLE' };

  const algorithmOf = (localName: string) =>
    Array.from(signature.getElementsByTagNameNS(XMLDSIG_NS, localName)).map((e) => e.getAttribute('Algorithm'));
  const allowedTransforms = new Set<string>(profile.transforms);
  if (
    algorithmOf('SignatureMethod').some((a) => a !== profile.signatureAlgorithm) ||
    algorithmOf('DigestMethod').some((a) => a !== profile.digestAlgorithm) ||
    algorithmOf('CanonicalizationMethod').some((a) => a !== profile.canonicalizationAlgorithm) ||
    algorithmOf('Transform').some((a) => a === null || !allowedTransforms.has(a))
  ) {
    return { valid: false, reason: 'ALGORITHM_NOT_ALLOWED' };
  }

  const verifier = new SignedXml({ publicCert: certificatePem });
  try {
    verifier.loadSignature(signature);
    return verifier.checkSignature(signedXml) ? { valid: true } : { valid: false, reason: 'SIGNATURE_INVALID' };
  } catch {
    return { valid: false, reason: 'SIGNATURE_INVALID' };
  }
}
