import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import forge from 'node-forge';

/**
 * Abre um PKCS#12 (PFX) inteiramente em memória, sem disco e sem processo externo
 * (docs/architecture/13). Usa node-forge porque o Node não expõe parsing de PKCS#12 para
 * KeyObject, e o OpenSSL 3 embutido no Node recusa PFX com criptografia legada (RC2/3DES-SHA1)
 * no `tls.createSecureContext({ pfx })` sem o provider "legacy".
 */
export interface OpenedCertificate {
  readonly privateKey: KeyObject;
  readonly certificate: X509Certificate;
  readonly certificatePem: string;
  readonly chainPem: readonly string[];
}

export class Pkcs12Error extends Error {
  constructor(readonly code: 'PKCS12_INVALID_PASSWORD' | 'PKCS12_MALFORMED' | 'PKCS12_NO_KEY' | 'PKCS12_KEY_CERT_MISMATCH' | 'PKCS12_UNSUPPORTED_KEY') {
    super(code);
    this.name = 'Pkcs12Error';
  }
}

export function openPkcs12(pfx: Buffer, password: string): OpenedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, true, password);
  } catch (error) {
    // Mensagem do forge descartada de propósito: não propagar detalhes do material.
    const message = error instanceof Error ? error.message : '';
    throw new Pkcs12Error(/MAC could not be verified|Invalid password|decrypt/i.test(message) ? 'PKCS12_INVALID_PASSWORD' : 'PKCS12_MALFORMED');
  }

  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag ?? '' })[forge.pki.oids.pkcs8ShroudedKeyBag ?? ''] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag ?? '' })[forge.pki.oids.keyBag ?? ''] ?? []),
  ];
  const forgeKey = keyBags.find((b) => b.key)?.key;
  if (!forgeKey) throw new Pkcs12Error('PKCS12_NO_KEY');
  if (!('n' in forgeKey)) throw new Pkcs12Error('PKCS12_UNSUPPORTED_KEY');

  const certPems = (p12.getBags({ bagType: forge.pki.oids.certBag ?? '' })[forge.pki.oids.certBag ?? ''] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => c !== undefined)
    .map((c) => forge.pki.certificateToPem(c));

  // A string PEM da chave existe brevemente no heap; o controle principal é onde este código
  // roda (só no worker-fiscal). Limitação registrada em docs/spikes/01.
  const privateKey = createPrivateKey(forge.pki.privateKeyToPem(forgeKey));

  const leafPem = certPems.find((pem) => new X509Certificate(pem).checkPrivateKey(privateKey));
  if (leafPem === undefined) throw new Pkcs12Error('PKCS12_KEY_CERT_MISMATCH');

  return {
    privateKey,
    certificate: new X509Certificate(leafPem),
    certificatePem: leafPem,
    chainPem: certPems.filter((pem) => pem !== leafPem),
  };
}
