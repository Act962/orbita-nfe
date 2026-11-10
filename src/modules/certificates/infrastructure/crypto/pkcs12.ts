import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import forge from 'node-forge';
import type { CertificateMaterial, OpenedCertificate, Pkcs12Failure, Pkcs12Reader } from '../../application/ports.js';

/**
 * Leitura do PKCS#12 (PFX) inteiramente em memória, sem disco e sem processo externo.
 * Promovido do spike 01 (docs/spikes): node-forge porque o Node não expõe PKCS#12 → KeyObject e
 * o OpenSSL 3 do Node recusa PFX com criptografia legada (RC2/3DES) sem o provider "legacy".
 *
 * Limitação aceita (ADR-0009): senha e chave passam brevemente por string no heap; o controle
 * principal é que este código só roda no worker-fiscal.
 */

/** OID do CNPJ do titular em certificado de pessoa jurídica (otherName do SubjectAltName). Fonte: DOC-ICP-04.01 (ITI). */
export const OID_ICP_BRASIL_CNPJ = '2.16.76.1.3.3';

class ReadFailure extends Error {
  constructor(readonly reason: Pkcs12Failure) {
    super(reason);
  }
}

function bagsOf(p12: forge.pkcs12.Pkcs12Pfx, bagType: string | undefined): forge.pkcs12.Bag[] {
  if (bagType === undefined) return [];
  return p12.getBags({ bagType })[bagType] ?? [];
}

function decode(material: CertificateMaterial): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(material.pfx.toString('binary')));
    return forge.pkcs12.pkcs12FromAsn1(asn1, true, material.password.toString('utf8'));
  } catch (error) {
    // A mensagem do forge é descartada: só decide o código.
    const message = error instanceof Error ? error.message : '';
    throw new ReadFailure(/MAC could not be verified|Invalid password|decrypt/i.test(message) ? 'PKCS12_INVALID_PASSWORD' : 'PKCS12_MALFORMED');
  }
}

/** Texto de um valor ASN.1 primitivo (OCTET STRING, PrintableString, UTF8String, IA5String). */
function asn1Text(node: forge.asn1.Asn1): string | undefined {
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.value) && node.value.length === 1 && node.value[0] !== undefined) return asn1Text(node.value[0]);
  return undefined;
}

/**
 * CNPJ do titular: otherName com OID 2.16.76.1.3.3, conteúdo de 14 posições (DOC-ICP-04).
 * Nunca usa o CN ("NOME:CNPJ") como fonte: é texto livre da AC.
 */
export function extractIcpBrasilCnpj(certificate: forge.pki.Certificate): string | null {
  const extension = certificate.getExtension('subjectAltName') as { altNames?: { type: number; value: unknown }[] } | undefined;
  for (const altName of extension?.altNames ?? []) {
    if (altName.type !== 0 || !Array.isArray(altName.value)) continue;
    const [typeId, explicitValue] = altName.value as forge.asn1.Asn1[];
    if (typeId === undefined || explicitValue === undefined || typeof typeId.value !== 'string') continue;
    if (forge.asn1.derToOid(typeId.value) !== OID_ICP_BRASIL_CNPJ) continue;
    const text = asn1Text(explicitValue)?.trim().toUpperCase();
    if (text !== undefined && /^[0-9A-Z]{12}[0-9]{2}$/.test(text)) return text;
  }
  return null;
}

function commonName(attributes: forge.pki.CertificateField[]): string {
  const cn = attributes.find((a) => a.shortName === 'CN' || a.name === 'commonName');
  return typeof cn?.value === 'string' ? cn.value : '';
}

export class ForgePkcs12Reader implements Pkcs12Reader {
  read(material: CertificateMaterial): ReturnType<Pkcs12Reader['read']> {
    try {
      return { ok: true, value: this.open(material) };
    } catch (error) {
      if (error instanceof ReadFailure) return { ok: false, reason: error.reason };
      return { ok: false, reason: 'PKCS12_MALFORMED' };
    }
  }

  private open(material: CertificateMaterial): OpenedCertificate {
    const p12 = decode(material);
    const keyBags = [...bagsOf(p12, forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(p12, forge.pki.oids.keyBag)];
    const forgeKey = keyBags.find((b) => b.key)?.key;
    if (!forgeKey) throw new ReadFailure('PKCS12_NO_KEY');
    if (!('n' in forgeKey)) throw new ReadFailure('PKCS12_UNSUPPORTED_KEY');

    const forgeCerts = bagsOf(p12, forge.pki.oids.certBag)
      .map((b) => b.cert)
      .filter((c): c is forge.pki.Certificate => c !== undefined);
    const privateKey: KeyObject = createPrivateKey(forge.pki.privateKeyToPem(forgeKey));

    const entries = forgeCerts.map((cert) => ({ cert, pem: forge.pki.certificateToPem(cert) }));
    const leaf = entries.find((e) => new X509Certificate(e.pem).checkPrivateKey(privateKey));
    if (leaf === undefined) throw new ReadFailure('PKCS12_KEY_CERT_MISMATCH');

    const x509 = new X509Certificate(leaf.pem);
    const keyUsage = leaf.cert.getExtension('keyUsage') as { digitalSignature?: boolean } | undefined;
    const notBefore = new Date(x509.validFrom);
    const notAfter = new Date(x509.validTo);
    const subjectCnpj = extractIcpBrasilCnpj(leaf.cert);

    return {
      privateKey,
      certificatePem: leaf.pem,
      chainPem: entries.filter((e) => e !== leaf).map((e) => e.pem),
      metadata: {
        subjectCnpj: subjectCnpj ?? '',
        subjectName: commonName(leaf.cert.subject.attributes),
        issuerName: commonName(leaf.cert.issuer.attributes),
        serialNumber: x509.serialNumber.toUpperCase(),
        notBefore,
        notAfter,
        thumbprintSha256: x509.fingerprint256.replace(/:/g, '').toLowerCase(),
      },
      facts: { notBefore, notAfter, subjectCnpj, digitalSignature: keyUsage?.digitalSignature === true },
    };
  }
}
