import type { KeyObject } from 'node:crypto';
import type { AuditTrail } from '../../../shared/application/audit.js';
import type { Certificate, CertificateFacts, CertificateMetadata, RejectionReason } from '../domain/certificate.js';

/** Material sensível em trânsito. Nunca logado, nunca serializado, zerado após o uso. */
export interface CertificateMaterial {
  readonly pfx: Buffer;
  readonly password: Buffer;
}

/** Vínculo do envelope: a decifragem falha se o blob for movido para outra empresa/certificado. */
export interface EnvelopeBinding {
  readonly companyId: string;
  readonly certificateId: string;
}

/** Envelope (ADR-0009): DEK própria, embrulhada pela KEK pública. Nada aqui é decifrável sem a KEK privada. */
export interface SealedCertificate {
  readonly envelopeVersion: number;
  readonly kekId: string;
  readonly wrappedDek: Buffer;
  readonly pfxSealed: Buffer;
  readonly passwordSealed: Buffer;
}

/** Só a KEK pública: disponível na API. */
export interface CertificateSealer {
  seal(material: CertificateMaterial, binding: EnvelopeBinding): SealedCertificate;
}

/** KEK privada: disponível SÓ no worker-fiscal. */
export interface CertificateOpener {
  open(sealed: SealedCertificate, binding: EnvelopeBinding): CertificateMaterial;
}

/** Certificado aberto em memória (worker-fiscal). */
export interface OpenedCertificate {
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
  readonly chainPem: readonly string[];
  readonly metadata: CertificateMetadata;
  readonly facts: Omit<CertificateFacts, 'chainTrusted'>;
}

export type Pkcs12Failure = Extract<RejectionReason, `PKCS12_${string}`>;

export interface Pkcs12Reader {
  read(material: CertificateMaterial): { ok: true; value: OpenedCertificate } | { ok: false; reason: Pkcs12Failure };
}

/** Cadeia até uma AC raiz confiável (bundle ICP-Brasil versionado). */
export interface TrustStore {
  isTrusted(certificatePem: string, chainPem: readonly string[], at: Date): boolean;
}

export interface NewCertificate {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly sealed: SealedCertificate;
}

/** Visão da API: apenas metadados (grants de coluna impedem ler o resto). */
export interface CertificateRepository {
  insert(certificate: NewCertificate): Promise<Certificate>;
  findById(establishmentId: string, id: string): Promise<Certificate | undefined>;
  listByEstablishment(establishmentId: string): Promise<Certificate[]>;
  /** REVOKED + destruição criptográfica (wrapped_dek apagada). */
  revoke(id: string): Promise<Certificate | undefined>;
}

/** Visão do worker-fiscal: lê o envelope e grava o resultado da validação. */
export interface SealedCertificateRepository {
  /** Trava a linha até o fim da transação. */
  lockById(id: string): Promise<(Certificate & { sealed: SealedCertificate | null }) | undefined>;
  findActive(establishmentId: string): Promise<(Certificate & { sealed: SealedCertificate | null }) | undefined>;
  listPendingIds(): Promise<string[]>;
  activate(id: string, metadata: CertificateMetadata): Promise<void>;
  reject(id: string, reason: RejectionReason): Promise<void>;
  /** Marca como REPLACED os ACTIVE do estabelecimento, exceto `keepId`. Devolve os ids. */
  replaceOthers(establishmentId: string, keepId: string): Promise<string[]>;
}

export interface EstablishmentLookup {
  exists(establishmentId: string): Promise<boolean>;
}

export interface CompanyLookup {
  /** Raiz do CNPJ da empresa do contexto. */
  currentRootCnpj(): Promise<string | undefined>;
}

export interface CertificateApiRepositories {
  readonly certificates: CertificateRepository;
  readonly establishments: EstablishmentLookup;
  readonly audit: AuditTrail;
}

export interface CertificateWorkerRepositories {
  readonly certificates: SealedCertificateRepository;
  readonly company: CompanyLookup;
  readonly audit: AuditTrail;
}
