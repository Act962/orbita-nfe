import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { MAX_PASSWORD_LENGTH, MAX_PFX_BYTES, type Certificate } from '../domain/certificate.js';
import type { CertificateApiRepositories, CertificateMaterial, CertificateSealer } from './ports.js';

const establishmentNotFound = (): NotFoundError => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.');
const certificateNotFound = (): NotFoundError => new NotFoundError('CERTIFICATE_NOT_FOUND', 'Certificado não encontrado.');

/** Zera o material sensível (melhor esforço: o runtime pode manter cópias internas, doc 13 §4). */
export function wipe(material: CertificateMaterial): void {
  material.pfx.fill(0);
  material.password.fill(0);
}

/**
 * Casos de uso da API (papel fiscal_api). A API só tem a KEK PÚBLICA: cifra o certificado
 * recebido e nunca consegue decifrá-lo (ADR-0009). A validação acontece no worker-fiscal.
 */
export class CertificateService {
  constructor(
    private readonly uow: UnitOfWork<CertificateApiRepositories>,
    private readonly sealer: CertificateSealer,
    private readonly newId: IdGenerator,
  ) {}

  /** Recebe o PFX e a senha, cifra e grava como PENDING_VALIDATION. O material é zerado ao final, com sucesso ou erro. */
  async upload(companyId: string, establishmentId: string, material: CertificateMaterial, context: AuditContext): Promise<Certificate> {
    try {
      const issues = [];
      if (material.pfx.length === 0 || material.pfx.length > MAX_PFX_BYTES) {
        issues.push({ code: 'CERTIFICATE_FILE_SIZE', field: 'pfx', message: `O arquivo PFX deve ter de 1 byte a ${MAX_PFX_BYTES / 1024} KB.` });
      }
      if (material.password.length === 0 || material.password.length > MAX_PASSWORD_LENGTH) {
        issues.push({ code: 'CERTIFICATE_PASSWORD_LENGTH', field: 'password', message: `A senha deve ter de 1 a ${MAX_PASSWORD_LENGTH} bytes.` });
      }
      if (issues.length > 0) throw new ValidationFailedError(issues);

      const id = this.newId();
      const sealed = this.sealer.seal(material, { companyId, certificateId: id });
      return await this.uow.inCompany(companyId, async (r) => {
        if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
        const certificate = await r.certificates.insert({ id, companyId, establishmentId, sealed });
        await r.audit.record(context, {
          action: 'certificate.uploaded',
          subject: { type: 'certificate', id },
          details: { establishmentId, envelopeKeyRef: sealed.kekId, envelopeVersion: sealed.envelopeVersion },
        });
        return certificate;
      });
    } finally {
      wipe(material);
    }
  }

  async list(companyId: string, establishmentId: string): Promise<Certificate[]> {
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      return r.certificates.listByEstablishment(establishmentId);
    });
  }

  async get(companyId: string, establishmentId: string, certificateId: string): Promise<Certificate> {
    const found = await this.uow.inCompany(companyId, (r) => r.certificates.findById(establishmentId, certificateId));
    if (found === undefined) throw certificateNotFound();
    return found;
  }

  /**
   * Revoga e destrói a chave do envelope: o ciphertext que sobra é inútil. Irreversível; a
   * emissão do estabelecimento para até um novo certificado ser validado.
   */
  async revoke(companyId: string, establishmentId: string, certificateId: string, context: AuditContext): Promise<Certificate> {
    return this.uow.inCompany(companyId, async (r) => {
      const current = await r.certificates.findById(establishmentId, certificateId);
      if (current === undefined) throw certificateNotFound();
      if (current.status === 'REVOKED') throw new BusinessRuleError('CERTIFICATE_ALREADY_REVOKED', 'O certificado já está revogado.');
      const revoked = await r.certificates.revoke(certificateId);
      if (revoked === undefined) throw certificateNotFound();
      await r.audit.record(context, {
        action: 'certificate.revoked',
        subject: { type: 'certificate', id: certificateId },
        details: { establishmentId, previousStatus: current.status },
      });
      return revoked;
    });
  }
}
