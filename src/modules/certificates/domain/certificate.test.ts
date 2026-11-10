import { describe, expect, it } from 'vitest';
import { computeCnpjCheckDigits } from '../../../shared/domain/cnpj.js';
import { displayedStatus, evaluateCertificate, type CertificateFacts } from './certificate.js';

/** CNPJ válido de outra raiz. */
const OTHER_ROOT_CNPJ = `998887770001${computeCnpjCheckDigits('998887770001')}`;
const now = new Date('2026-11-10T12:00:00Z');
const day = 86_400_000;
const valid: CertificateFacts = {
  notBefore: new Date(now.getTime() - day),
  notAfter: new Date(now.getTime() + 365 * day),
  subjectCnpj: '11222333000181',
  chainTrusted: true,
  digitalSignature: true,
};

describe('evaluateCertificate (CERT-001)', () => {
  it('aceita e-CNPJ válido, confiável e da mesma raiz (matriz serve às filiais)', () => {
    expect(evaluateCertificate(valid, '11222333', now)).toEqual({ ok: true });
  });

  it.each([
    [{ chainTrusted: false }, 'CERTIFICATE_CHAIN_UNTRUSTED'],
    [{ notBefore: new Date(now.getTime() + day) }, 'CERTIFICATE_NOT_YET_VALID'],
    [{ notAfter: new Date(now.getTime() - 1) }, 'CERTIFICATE_EXPIRED'],
    [{ subjectCnpj: null }, 'CERTIFICATE_NOT_LEGAL_ENTITY'],
    [{ subjectCnpj: '11222333000182' }, 'CERTIFICATE_NOT_LEGAL_ENTITY'],
    [{ subjectCnpj: OTHER_ROOT_CNPJ }, 'CERTIFICATE_CNPJ_MISMATCH'],
    [{ digitalSignature: false }, 'CERTIFICATE_KEY_USAGE_INVALID'],
  ] as const)('%o → %s', (override, reason) => {
    expect(evaluateCertificate({ ...valid, ...override }, '11222333', now)).toEqual({ ok: false, reason });
  });

  it('a cadeia é conferida antes de tudo (certificado falso não revela nada além disso)', () => {
    expect(evaluateCertificate({ ...valid, chainTrusted: false, subjectCnpj: null, notAfter: new Date(0) }, '11222333', now)).toEqual({
      ok: false,
      reason: 'CERTIFICATE_CHAIN_UNTRUSTED',
    });
  });
});

describe('displayedStatus', () => {
  const metadata = (notAfter: Date) => ({
    subjectCnpj: '11222333000181',
    subjectName: 'X',
    issuerName: 'AC',
    serialNumber: '01',
    notBefore: new Date(0),
    notAfter,
    thumbprintSha256: 'a'.repeat(64),
  });

  it('ACTIVE vira EXPIRING nos últimos 30 dias e EXPIRED depois do vencimento', () => {
    expect(displayedStatus({ status: 'ACTIVE', metadata: metadata(new Date(now.getTime() + 31 * day)) }, now)).toBe('ACTIVE');
    expect(displayedStatus({ status: 'ACTIVE', metadata: metadata(new Date(now.getTime() + 30 * day)) }, now)).toBe('EXPIRING');
    expect(displayedStatus({ status: 'ACTIVE', metadata: metadata(new Date(now.getTime() - 1)) }, now)).toBe('EXPIRED');
  });

  it('demais status são exibidos como estão', () => {
    expect(displayedStatus({ status: 'PENDING_VALIDATION', metadata: null }, now)).toBe('PENDING_VALIDATION');
    expect(displayedStatus({ status: 'REPLACED', metadata: metadata(new Date(0)) }, now)).toBe('REPLACED');
    expect(displayedStatus({ status: 'ACTIVE', metadata: null }, now)).toBe('ACTIVE');
  });
});
