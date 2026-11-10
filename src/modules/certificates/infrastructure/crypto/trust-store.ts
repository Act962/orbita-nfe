import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TrustStore } from '../../application/ports.js';

const MAX_DEPTH = 6;

function parseBundle(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

const validAt = (cert: X509Certificate, at: Date): boolean =>
  at.getTime() >= new Date(cert.validFrom).getTime() && at.getTime() <= new Date(cert.validTo).getTime();

const issuedBy = (child: X509Certificate, issuer: X509Certificate): boolean => child.checkIssued(issuer) && child.verify(issuer.publicKey);

/**
 * Validação de cadeia até uma AC raiz do bundle confiável (doc 13 §4).
 *
 * Confere emissor, assinatura, validade das ACs na data e `CA:TRUE` dos intermediários. A raiz
 * só é aceita se estiver no bundle (o PFX pode trazer qualquer certificado). A validade do
 * próprio certificado é decidida no domínio (CERTIFICATE_EXPIRED / NOT_YET_VALID), para o motivo
 * da rejeição ser o correto. Não consulta LCR/OCSP: revogação fica registrada como dívida.
 */
export class X509TrustStore implements TrustStore {
  private constructor(private readonly roots: readonly X509Certificate[]) {}

  static fromPem(pem: string): X509TrustStore {
    const roots = parseBundle(pem);
    if (roots.length === 0) throw new Error('bundle de ACs confiáveis vazio');
    return new X509TrustStore(roots);
  }

  static fromFile(path: string): X509TrustStore {
    return X509TrustStore.fromPem(readFileSync(path, 'utf8'));
  }

  isTrusted(certificatePem: string, chainPem: readonly string[], at: Date): boolean {
    let current: X509Certificate;
    let intermediates: X509Certificate[];
    try {
      current = new X509Certificate(certificatePem);
      intermediates = chainPem.map((pem) => new X509Certificate(pem));
    } catch {
      return false;
    }

    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const root = this.roots.find((r) => r.ca && validAt(r, at) && issuedBy(current, r));
      if (root !== undefined) return true;
      const next = intermediates.find((i) => i.ca && validAt(i, at) && i.fingerprint256 !== current.fingerprint256 && issuedBy(current, i));
      if (next === undefined) return false;
      current = next;
    }
    return false;
  }
}
