import { Cnpj } from '../../../shared/domain/cnpj.js';

/**
 * Certificado A1 de empresa (docs/architecture/13, ADR-0009, ADR-0027).
 *
 * Status gravado:
 *   PENDING_VALIDATION → ACTIVE | REJECTED | REVOKED
 *   ACTIVE → REPLACED | REVOKED
 *   REPLACED | REJECTED → REVOKED
 * O trigger da migration de segurança impõe as mesmas transições no banco.
 *
 * Status exibido: ACTIVE vira EXPIRING (até 30 dias para vencer) ou EXPIRED (vencido).
 */
export const CERTIFICATE_STATUSES = ['PENDING_VALIDATION', 'ACTIVE', 'REJECTED', 'REPLACED', 'REVOKED'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const DISPLAYED_CERTIFICATE_STATUSES = [...CERTIFICATE_STATUSES, 'EXPIRING', 'EXPIRED'] as const;
export type DisplayedCertificateStatus = (typeof DISPLAYED_CERTIFICATE_STATUSES)[number];

/** Janela de aviso de vencimento (alertas em 30/15/7/1 dias, doc 13 §4). */
export const EXPIRING_WINDOW_DAYS = 30;

/** Limites do upload (doc 13 §4). Um PFX A1 real tem poucos KB. */
export const MAX_PFX_BYTES = 50 * 1024;
export const MAX_PASSWORD_LENGTH = 128;

/** Motivos de rejeição: códigos estáveis, sem nenhum dado do certificado. */
export const REJECTION_REASONS = [
  'PKCS12_INVALID_PASSWORD',
  'PKCS12_MALFORMED',
  'PKCS12_NO_KEY',
  'PKCS12_KEY_CERT_MISMATCH',
  'PKCS12_UNSUPPORTED_KEY',
  'CERTIFICATE_NOT_YET_VALID',
  'CERTIFICATE_EXPIRED',
  'CERTIFICATE_CHAIN_UNTRUSTED',
  'CERTIFICATE_NOT_LEGAL_ENTITY',
  'CERTIFICATE_CNPJ_MISMATCH',
  'CERTIFICATE_KEY_USAGE_INVALID',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface CertificateMetadata {
  readonly subjectCnpj: string;
  readonly subjectName: string;
  readonly issuerName: string;
  readonly serialNumber: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly thumbprintSha256: string;
}

export interface Certificate {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly status: CertificateStatus;
  readonly rejectionReason: RejectionReason | null;
  readonly metadata: CertificateMetadata | null;
  readonly createdAt: Date;
  readonly validatedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Fatos extraídos do certificado aberto (worker-fiscal), sem material sensível. */
export interface CertificateFacts {
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** CNPJ do titular (OID 2.16.76.1.3.3, DOC-ICP-04); null se ausente. */
  readonly subjectCnpj: string | null;
  readonly chainTrusted: boolean;
  readonly digitalSignature: boolean;
}

/**
 * Decide se o certificado pode ser usado pela empresa (CERT-001). Ordem: cadeia, validade,
 * titular, raiz do CNPJ e uso de chave. Mesma raiz = mesma empresa (COMPANY-001): o
 * certificado da matriz serve às filiais.
 */
export function evaluateCertificate(facts: CertificateFacts, companyRootCnpj: string, now: Date): { ok: true } | { ok: false; reason: RejectionReason } {
  if (!facts.chainTrusted) return { ok: false, reason: 'CERTIFICATE_CHAIN_UNTRUSTED' };
  if (now.getTime() < facts.notBefore.getTime()) return { ok: false, reason: 'CERTIFICATE_NOT_YET_VALID' };
  if (now.getTime() > facts.notAfter.getTime()) return { ok: false, reason: 'CERTIFICATE_EXPIRED' };
  if (facts.subjectCnpj === null) return { ok: false, reason: 'CERTIFICATE_NOT_LEGAL_ENTITY' };
  const cnpj = Cnpj.parse(facts.subjectCnpj);
  if (!cnpj.ok) return { ok: false, reason: 'CERTIFICATE_NOT_LEGAL_ENTITY' };
  if (cnpj.value.root !== companyRootCnpj) return { ok: false, reason: 'CERTIFICATE_CNPJ_MISMATCH' };
  if (!facts.digitalSignature) return { ok: false, reason: 'CERTIFICATE_KEY_USAGE_INVALID' };
  return { ok: true };
}

export function displayedStatus(certificate: Pick<Certificate, 'status' | 'metadata'>, now: Date): DisplayedCertificateStatus {
  if (certificate.status !== 'ACTIVE' || certificate.metadata === null) return certificate.status;
  const remainingMs = certificate.metadata.notAfter.getTime() - now.getTime();
  if (remainingMs < 0) return 'EXPIRED';
  return remainingMs <= EXPIRING_WINDOW_DAYS * 86_400_000 ? 'EXPIRING' : 'ACTIVE';
}

/**
 * Avisos de vencimento (doc 13 §4, doc 05 §5): `certificate.expiring` a 30, 15, 7 e 1 dia do
 * vencimento e `certificate.expired` no vencimento (limiar 0). O primeiro limiar coincide com a
 * janela de EXPIRING exibida.
 */
export const EXPIRY_NOTICE_DAYS = [EXPIRING_WINDOW_DAYS, 15, 7, 1, 0] as const;
const DAY_MS = 86_400_000;

/**
 * Quando agendar os avisos de um certificado recém-ativado: cada limiar ainda no futuro, mais
 * `now` se o certificado já está dentro de alguma janela (ativado com menos de 30 dias de
 * validade, por exemplo). Avisos repetidos para o mesmo limiar são descartados no envio.
 */
export function expiryNoticeTimes(notAfter: Date, now: Date): Date[] {
  const times = EXPIRY_NOTICE_DAYS.map((days) => new Date(notAfter.getTime() - days * DAY_MS)).filter((at) => at.getTime() > now.getTime());
  const alreadyInWindow = notAfter.getTime() - now.getTime() <= EXPIRING_WINDOW_DAYS * DAY_MS;
  return alreadyInWindow ? [now, ...times] : times;
}

/**
 * Qual aviso vale agora: o menor limiar já alcançado (dias restantes arredondados para cima).
 * 0 = vencido. `null` = ainda fora da janela de aviso.
 */
export function expiryNoticeThreshold(notAfter: Date, now: Date): { thresholdDays: number; daysRemaining: number } | null {
  const remainingMs = notAfter.getTime() - now.getTime();
  if (remainingMs <= 0) return { thresholdDays: 0, daysRemaining: 0 };
  const daysRemaining = Math.ceil(remainingMs / DAY_MS);
  const reached = EXPIRY_NOTICE_DAYS.filter((days) => days > 0 && daysRemaining <= days);
  if (reached.length === 0) return null;
  return { thresholdDays: Math.min(...reached), daysRemaining };
}
