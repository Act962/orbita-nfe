import { and, asc, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { NotFoundError } from '../../../../shared/application/errors.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { Transaction } from '../../../../shared/infrastructure/database/database.js';
import type { CertificateExpiryRepositories } from '../../application/expiry-notifier.js';
import type { CertificateRepository, SealedCertificate, SealedCertificateRepository } from '../../application/ports.js';
import type { Certificate, CertificateMetadata, CertificateStatus, RejectionReason } from '../../domain/certificate.js';
import { certificateExpiryNotices, certificates } from './schema.js';

export const CERTIFICATE_CONSTRAINTS: ConstraintErrorMap = {
  fk_certificates_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
};

/** Colunas que a API pode ler (grants de coluna na migration). Ler outra coluna = erro de permissão. */
const metadataColumns = {
  id: certificates.id,
  companyId: certificates.companyId,
  establishmentId: certificates.establishmentId,
  status: certificates.status,
  rejectionReason: certificates.rejectionReason,
  subjectCnpj: certificates.subjectCnpj,
  subjectName: certificates.subjectName,
  issuerName: certificates.issuerName,
  serialNumber: certificates.serialNumber,
  notBefore: certificates.notBefore,
  notAfter: certificates.notAfter,
  thumbprintSha256: certificates.thumbprintSha256,
  createdAt: certificates.createdAt,
  validatedAt: certificates.validatedAt,
  revokedAt: certificates.revokedAt,
};

type MetadataRow = { [K in keyof typeof metadataColumns]: (typeof certificates.$inferSelect)[K] };

function toCertificate(row: MetadataRow): Certificate {
  const metadata: CertificateMetadata | null =
    row.thumbprintSha256 !== null && row.notBefore !== null && row.notAfter !== null
      ? {
          subjectCnpj: row.subjectCnpj ?? '',
          subjectName: row.subjectName ?? '',
          issuerName: row.issuerName ?? '',
          serialNumber: row.serialNumber ?? '',
          notBefore: row.notBefore,
          notAfter: row.notAfter,
          thumbprintSha256: row.thumbprintSha256,
        }
      : null;
  return {
    id: row.id,
    companyId: row.companyId,
    establishmentId: row.establishmentId,
    status: row.status as CertificateStatus,
    rejectionReason: row.rejectionReason as RejectionReason | null,
    metadata,
    createdAt: row.createdAt,
    validatedAt: row.validatedAt,
    revokedAt: row.revokedAt,
  };
}

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING sem linha');
  return row;
}

/** Repositório da API (papel fiscal_api): grava o envelope, lê só metadados. */
export function certificateRepository(tx: Transaction): CertificateRepository {
  return {
    async insert(certificate) {
      // SQL explícito: o Drizzle lista TODAS as colunas (com DEFAULT) no INSERT, e a API só tem
      // INSERT nas colunas do envelope. Status e metadados ficam no padrão (PENDING_VALIDATION, nulos).
      const { sealed } = certificate;
      await tx.execute(sql`
        insert into certificates (id, company_id, establishment_id, envelope_version, kek_id, wrapped_dek, pfx_sealed, password_sealed)
        values (${certificate.id}, ${certificate.companyId}, ${certificate.establishmentId}, ${sealed.envelopeVersion}, ${sealed.kekId},
                ${sealed.wrappedDek}, ${sealed.pfxSealed}, ${sealed.passwordSealed})`);
      const rows = await tx.select(metadataColumns).from(certificates).where(eq(certificates.id, certificate.id)).limit(1);
      return toCertificate(one(rows));
    },
    async findById(establishmentId, id) {
      const rows = await tx
        .select(metadataColumns)
        .from(certificates)
        .where(and(eq(certificates.id, id), eq(certificates.establishmentId, establishmentId)))
        .limit(1);
      return rows[0] === undefined ? undefined : toCertificate(rows[0]);
    },
    async listByEstablishment(establishmentId) {
      const rows = await tx.select(metadataColumns).from(certificates).where(eq(certificates.establishmentId, establishmentId)).orderBy(desc(certificates.createdAt));
      return rows.map(toCertificate);
    },
    async revoke(id) {
      const rows = await tx
        .update(certificates)
        .set({ status: 'REVOKED', wrappedDek: null, revokedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(certificates.id, id), ne(certificates.status, 'REVOKED')))
        .returning(metadataColumns);
      return rows[0] === undefined ? undefined : toCertificate(rows[0]);
    },
  };
}

const sealedColumns = {
  ...metadataColumns,
  envelopeVersion: certificates.envelopeVersion,
  kekId: certificates.kekId,
  wrappedDek: certificates.wrappedDek,
  pfxSealed: certificates.pfxSealed,
  passwordSealed: certificates.passwordSealed,
};

type SealedRow = MetadataRow & { envelopeVersion: number; kekId: string; wrappedDek: Buffer | null; pfxSealed: Buffer; passwordSealed: Buffer };

function toSealed(row: SealedRow): Certificate & { sealed: SealedCertificate | null } {
  return {
    ...toCertificate(row),
    sealed:
      row.wrappedDek === null
        ? null
        : { envelopeVersion: row.envelopeVersion, kekId: row.kekId, wrappedDek: row.wrappedDek, pfxSealed: row.pfxSealed, passwordSealed: row.passwordSealed },
  };
}

/** Repositório do worker-fiscal (papel fiscal_worker). */
export function sealedCertificateRepository(tx: Transaction): SealedCertificateRepository {
  return {
    async lockById(id) {
      const rows = await tx.select(sealedColumns).from(certificates).where(eq(certificates.id, id)).limit(1).for('update');
      return rows[0] === undefined ? undefined : toSealed(rows[0]);
    },
    async findActive(establishmentId) {
      const rows = await tx
        .select(sealedColumns)
        .from(certificates)
        .where(and(eq(certificates.establishmentId, establishmentId), eq(certificates.status, 'ACTIVE')))
        .limit(1);
      return rows[0] === undefined ? undefined : toSealed(rows[0]);
    },
    async listPendingIds() {
      const rows = await tx.select({ id: certificates.id }).from(certificates).where(eq(certificates.status, 'PENDING_VALIDATION')).orderBy(asc(certificates.createdAt));
      return rows.map((r) => r.id);
    },
    async activate(id, metadata) {
      await tx
        .update(certificates)
        .set({
          status: 'ACTIVE',
          subjectCnpj: metadata.subjectCnpj,
          subjectName: metadata.subjectName,
          issuerName: metadata.issuerName,
          serialNumber: metadata.serialNumber,
          notBefore: metadata.notBefore,
          notAfter: metadata.notAfter,
          thumbprintSha256: metadata.thumbprintSha256,
          validatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(certificates.id, id));
    },
    async reject(id, reason) {
      await tx.update(certificates).set({ status: 'REJECTED', rejectionReason: reason, validatedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(certificates.id, id));
    },
    async replaceOthers(establishmentId, keepId) {
      const rows = await tx
        .update(certificates)
        .set({ status: 'REPLACED', replacedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(certificates.establishmentId, establishmentId), eq(certificates.status, 'ACTIVE'), ne(certificates.id, keepId)))
        .returning({ id: certificates.id });
      return rows.map((r) => r.id);
    },
  };
}

/**
 * Pergunta de outros módulos (via composition root): o estabelecimento tem certificado ACTIVE e
 * dentro da validade em `at`? Lê só status e vencimento, nunca o envelope.
 */
export function certificateAvailability(tx: Transaction): { hasUsableCertificate(establishmentId: string, at: Date): Promise<boolean> } {
  return {
    async hasUsableCertificate(establishmentId, at) {
      const rows = await tx
        .select({ id: certificates.id })
        .from(certificates)
        .where(and(eq(certificates.establishmentId, establishmentId), eq(certificates.status, 'ACTIVE'), gt(certificates.notAfter, at)))
        .limit(1);
      return rows.length > 0;
    },
  };
}

/** Leitura do worker-general: só as colunas do grant dele (id, empresa, estabelecimento, vencimento, status). */
export function certificateExpiryReader(tx: Transaction): CertificateExpiryRepositories['certificates'] {
  return {
    async findForExpiry(certificateId) {
      const rows = await tx
        .select({ id: certificates.id, establishmentId: certificates.establishmentId, status: certificates.status, notAfter: certificates.notAfter })
        .from(certificates)
        .where(eq(certificates.id, certificateId))
        .limit(1);
      return rows[0];
    },
  };
}

export function certificateExpiryNoticeRepository(tx: Transaction): CertificateExpiryRepositories['notices'] {
  return {
    async record(certificateId, thresholdDays) {
      const rows = await tx
        .insert(certificateExpiryNotices)
        .values({ companyId: sql`app_current_company()`, certificateId, thresholdDays })
        .onConflictDoNothing()
        .returning({ certificateId: certificateExpiryNotices.certificateId });
      return rows.length > 0;
    },
  };
}
