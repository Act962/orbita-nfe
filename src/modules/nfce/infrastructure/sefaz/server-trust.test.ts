import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestPki } from '../../../../../test/support/tls-test-pki.js';
import { ICP_BRASIL_V10_FILE, loadServerTrust, ServerTrustError } from './server-trust.js';

const TRUST_DIR = resolve(import.meta.dirname, '../../../../../resources/fiscal/trust/icp-brasil');

function folder(pem: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'trust-'));
  writeFileSync(join(dir, 'raiz.pem'), pem);
  const sha256 = createHash('sha256').update(pem).digest('hex');
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify({ files: { 'raiz.pem': { sha256 } } }));
  return dir;
}

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ServerTrustError) return error.code;
    throw error;
  }
  return undefined;
}

describe('raiz confiável do TLS da NFC-e (ADR-0068)', () => {
  it('carrega a AC Raiz Brasileira v10 versionada, com o hash do MANIFEST', () => {
    const pem = loadServerTrust(TRUST_DIR, ICP_BRASIL_V10_FILE, new Date('2026-11-25T00:00:00Z'));
    const certificate = new X509Certificate(pem);
    expect(certificate.subject).toContain('CN=Autoridade Certificadora Raiz Brasileira v10');
    expect(certificate.fingerprint256).toBe('6E:0B:FF:06:9A:26:99:4C:15:DE:2C:48:88:CC:54:AF:84:88:2E:54:95:B7:FB:F6:6B:E9:CC:FF:EC:74:89:F6');
  });

  it('arquivo alterado depois do MANIFEST → recusa', () => {
    const dir = folder(readFileSync(join(TRUST_DIR, ICP_BRASIL_V10_FILE), 'utf8'));
    writeFileSync(join(dir, 'raiz.pem'), `${readFileSync(join(dir, 'raiz.pem'), 'utf8')}\n`);
    expect(code(() => loadServerTrust(dir, 'raiz.pem'))).toBe('SERVER_TRUST_HASH_MISMATCH');
  });

  it('fora da validade da raiz → recusa', () => {
    expect(code(() => loadServerTrust(TRUST_DIR, ICP_BRASIL_V10_FILE, new Date('2032-07-02T00:00:00Z')))).toBe('SERVER_TRUST_EXPIRED');
  });

  it('certificado que não é AC raiz autoassinada → recusa, mesmo com hash certo', () => {
    const pki = createTestPki();
    expect(code(() => loadServerTrust(folder(pki.server.certPem), 'raiz.pem'))).toBe('SERVER_TRUST_INVALID');
  });

  it('PEM que não é certificado → recusa', () => {
    expect(code(() => loadServerTrust(folder('não é PEM'), 'raiz.pem'))).toBe('SERVER_TRUST_INVALID');
  });
});
