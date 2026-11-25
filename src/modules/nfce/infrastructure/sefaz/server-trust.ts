import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Raiz confiável para o certificado TLS dos autorizadores da NFC-e (ADR-0068).
 *
 * O SVRS apresenta a cadeia *.svrs.rs.gov.br → AC SERPRO SSLv1 → AC Raiz Brasileira v10 (ICP-Brasil).
 * A raiz v10 não está no repositório padrão do Node (Mozilla), então a conexão falha com
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY. A correção é confiar nesta raiz versionada, com o hash
 * conferido na carga, e nunca desligar a verificação.
 */
export class ServerTrustError extends Error {
  constructor(readonly code: 'SERVER_TRUST_INVALID' | 'SERVER_TRUST_HASH_MISMATCH' | 'SERVER_TRUST_EXPIRED', readonly file: string) {
    super(`${code}: ${file}`);
    this.name = 'ServerTrustError';
  }
}

export const ICP_BRASIL_V10_FILE = 'ac-raiz-icp-brasil-v10.pem';

export function loadServerTrust(dir: string, file: string = ICP_BRASIL_V10_FILE, now: Date = new Date()): string {
  const path = join(dir, file);
  let expected: unknown;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { files?: Record<string, { sha256?: unknown }> };
    expected = manifest.files?.[file]?.sha256;
  } catch {
    throw new ServerTrustError('SERVER_TRUST_INVALID', join(dir, 'MANIFEST.json'));
  }
  const bytes = readFileSync(path);
  if (typeof expected !== 'string' || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new ServerTrustError('SERVER_TRUST_HASH_MISMATCH', path);
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(bytes);
  } catch {
    throw new ServerTrustError('SERVER_TRUST_INVALID', path);
  }
  // Só uma AC raiz autoassinada serve de âncora.
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
    throw new ServerTrustError('SERVER_TRUST_INVALID', path);
  }
  if (now.getTime() > Date.parse(certificate.validTo) || now.getTime() < Date.parse(certificate.validFrom)) {
    throw new ServerTrustError('SERVER_TRUST_EXPIRED', path);
  }
  return bytes.toString('utf8');
}
