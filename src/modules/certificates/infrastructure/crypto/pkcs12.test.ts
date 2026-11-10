import { createSign, createVerify, X509Certificate } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestIcpPki, type TestIcpPki } from '../../../../../test/support/icp-test-pki.js';
import { ForgePkcs12Reader } from './pkcs12.js';
import { X509TrustStore } from './trust-store.js';

const CNPJ = '11222333000181';
let pki: TestIcpPki;
const reader = new ForgePkcs12Reader();
const material = (pfx: Buffer, password: string) => ({ pfx, password: Buffer.from(password, 'utf8') });

beforeAll(() => {
  pki = createTestIcpPki();
});

describe('ForgePkcs12Reader', () => {
  it.each(['aes256', '3des'] as const)('abre PFX %s e extrai o CNPJ do otherName 2.16.76.1.3.3', (algorithm) => {
    const read = reader.read(material(pki.pfx({ cnpj: CNPJ, password: 'senha', algorithm }), 'senha'));
    if (!read.ok) throw new Error(read.reason);
    expect(read.value.facts.subjectCnpj).toBe(CNPJ);
    expect(read.value.facts.digitalSignature).toBe(true);
    expect(read.value.chainPem).toHaveLength(1);
    expect(read.value.metadata.thumbprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(read.value.metadata.thumbprintSha256).toBe(new X509Certificate(read.value.certificatePem).fingerprint256.replace(/:/g, '').toLowerCase());
    expect(read.value.metadata.subjectName).toContain('EMPRESA FICTICIA');
    // A chave é um KeyObject utilizável para assinar.
    const signature = createSign('sha256').update('xml').sign(read.value.privateKey);
    expect(createVerify('sha256').update('xml').verify(read.value.certificatePem, signature)).toBe(true);
  });

  it('aceita o valor do otherName também como texto', () => {
    const read = reader.read(material(pki.pfx({ cnpj: CNPJ, password: 's', cnpjEncoding: 'printable' }), 's'));
    expect(read.ok && read.value.facts.subjectCnpj).toBe(CNPJ);
  });

  it('não usa o CN como fonte do CNPJ: sem o OID, subjectCnpj é null', () => {
    const read = reader.read(material(pki.pfx({ cnpj: null, password: 's' }), 's'));
    expect(read.ok && read.value.facts.subjectCnpj).toBeNull();
  });

  it('senha errada → PKCS12_INVALID_PASSWORD; lixo → PKCS12_MALFORMED', () => {
    expect(reader.read(material(pki.pfx({ cnpj: CNPJ, password: 'certa' }), 'errada'))).toEqual({ ok: false, reason: 'PKCS12_INVALID_PASSWORD' });
    expect(reader.read(material(Buffer.from('nao e pfx'), 'x'))).toEqual({ ok: false, reason: 'PKCS12_MALFORMED' });
  });

  it('sem digitalSignature no keyUsage → digitalSignature false', () => {
    const read = reader.read(material(pki.pfx({ cnpj: CNPJ, password: 's', digitalSignature: false }), 's'));
    expect(read.ok && read.value.facts.digitalSignature).toBe(false);
  });
});

describe('X509TrustStore', () => {
  const openPem = (pfx: Buffer) => {
    const read = reader.read(material(pfx, 's'));
    if (!read.ok) throw new Error(read.reason);
    return read.value;
  };

  it('aceita cadeia folha → intermediária (no PFX) → raiz do bundle', () => {
    const store = X509TrustStore.fromPem(pki.trustBundlePem);
    const opened = openPem(pki.pfx({ cnpj: CNPJ, password: 's' }));
    expect(store.isTrusted(opened.certificatePem, opened.chainPem, new Date())).toBe(true);
  });

  it('recusa sem a intermediária, com AC fora do bundle e com AC fora da validade', () => {
    const store = X509TrustStore.fromPem(pki.trustBundlePem);
    const noChain = openPem(pki.pfx({ cnpj: CNPJ, password: 's', includeChain: false }));
    expect(store.isTrusted(noChain.certificatePem, noChain.chainPem, new Date())).toBe(false);
    const untrusted = openPem(pki.pfx({ cnpj: CNPJ, password: 's', issuer: pki.untrustedRoot }));
    expect(store.isTrusted(untrusted.certificatePem, untrusted.chainPem, new Date())).toBe(false);
    const valid = openPem(pki.pfx({ cnpj: CNPJ, password: 's' }));
    // As ACs de teste valem 10 anos; depois disso a cadeia não fecha.
    expect(store.isTrusted(valid.certificatePem, valid.chainPem, new Date(Date.now() + 11 * 365 * 86_400_000))).toBe(false);
    // A validade da folha não é critério da cadeia (o domínio decide CERTIFICATE_EXPIRED).
    expect(store.isTrusted(valid.certificatePem, valid.chainPem, new Date(Date.now() + 2 * 365 * 86_400_000))).toBe(true);
  });

  it('uma raiz falsa com o mesmo nome dentro do PFX não é aceita', () => {
    const store = X509TrustStore.fromPem(pki.trustBundlePem);
    const fake = openPem(pki.pfx({ cnpj: CNPJ, password: 's', issuer: pki.untrustedRoot }));
    expect(store.isTrusted(fake.certificatePem, [...fake.chainPem, pki.untrustedRoot.certPem], new Date())).toBe(false);
  });

  it('bundle vazio impede a criação', () => {
    expect(() => X509TrustStore.fromPem('')).toThrow();
  });
});
