import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, InternalError } from '../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { evaluateCertificate, type CertificateStatus, type RejectionReason } from '../domain/certificate.js';
import { wipe } from './certificate-service.js';
import type { CertificateOpener, CertificateWorkerRepositories, OpenedCertificate, Pkcs12Reader, TrustStore } from './ports.js';

export type ValidationOutcome =
  | { readonly kind: 'ACTIVATED'; readonly replaced: readonly string[] }
  | { readonly kind: 'REJECTED'; readonly reason: RejectionReason }
  | { readonly kind: 'SKIPPED'; readonly status: CertificateStatus | 'NOT_FOUND' };

/** O que `withCertificate` entrega: chave como KeyObject, nunca como texto ou bytes. */
export type CertificateInUse = Pick<OpenedCertificate, 'privateKey' | 'certificatePem' | 'chainPem'> & { readonly thumbprintSha256: string };

/**
 * Casos de uso do worker-fiscal (papel fiscal_worker), o ÚNICO processo com a KEK privada
 * (ADR-0009, ADR-0021): validação de certificados enviados e uso do certificado para assinatura e mTLS.
 */
export class CertificateVault {
  constructor(
    private readonly uow: UnitOfWork<CertificateWorkerRepositories>,
    private readonly opener: CertificateOpener,
    private readonly reader: Pkcs12Reader,
    private readonly trust: TrustStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Idempotente: certificado que não está PENDING_VALIDATION é ignorado. */
  async validate(companyId: string, certificateId: string, context: AuditContext): Promise<ValidationOutcome> {
    return this.uow.inCompany(companyId, async (r) => {
      const certificate = await r.certificates.lockById(certificateId);
      if (certificate === undefined) return { kind: 'SKIPPED', status: 'NOT_FOUND' };
      if (certificate.status !== 'PENDING_VALIDATION') return { kind: 'SKIPPED', status: certificate.status };
      if (certificate.sealed === null) throw new InternalError('CERTIFICATE_PENDING_WITHOUT_ENVELOPE');

      const rootCnpj = await r.company.currentRootCnpj();
      if (rootCnpj === undefined) throw new InternalError('COMPANY_CONTEXT_WITHOUT_COMPANY');

      const material = this.opener.open(certificate.sealed, { companyId, certificateId });
      let decision: { ok: true; opened: OpenedCertificate } | { ok: false; reason: RejectionReason };
      try {
        const read = this.reader.read(material);
        if (!read.ok) {
          decision = { ok: false, reason: read.reason };
        } else {
          const chainTrusted = this.trust.isTrusted(read.value.certificatePem, read.value.chainPem, this.now());
          const verdict = evaluateCertificate({ ...read.value.facts, chainTrusted }, rootCnpj, this.now());
          decision = verdict.ok ? { ok: true, opened: read.value } : { ok: false, reason: verdict.reason };
        }
      } finally {
        wipe(material);
      }

      const subject = { type: 'certificate', id: certificateId } as const;
      if (!decision.ok) {
        await r.certificates.reject(certificateId, decision.reason);
        await r.audit.record(context, { action: 'certificate.rejected', subject, details: { establishmentId: certificate.establishmentId, reason: decision.reason } });
        await r.events.publish({
          type: 'certificate.rejected',
          subject,
          data: { certificateId, establishmentId: certificate.establishmentId, status: 'REJECTED', reason: decision.reason },
          correlationId: context.correlationId,
        });
        return { kind: 'REJECTED', reason: decision.reason };
      }

      const metadata = decision.opened.metadata;
      // Sobreposição (ADR-0027): o anterior só sai depois que o novo foi validado, na mesma transação.
      const replaced = await r.certificates.replaceOthers(certificate.establishmentId, certificateId);
      await r.certificates.activate(certificateId, metadata);
      await r.audit.record(context, {
        action: 'certificate.activated',
        subject,
        details: {
          establishmentId: certificate.establishmentId,
          thumbprintSha256: metadata.thumbprintSha256,
          serialNumber: metadata.serialNumber,
          notAfter: metadata.notAfter.toISOString(),
        },
      });
      for (const id of replaced) {
        await r.audit.record(context, { action: 'certificate.replaced', subject: { type: 'certificate', id }, details: { establishmentId: certificate.establishmentId, replacedBy: certificateId } });
      }
      await r.events.publish({
        type: 'certificate.activated',
        subject,
        data: {
          certificateId,
          establishmentId: certificate.establishmentId,
          status: 'ACTIVE',
          notAfter: metadata.notAfter.toISOString(),
          replacedCertificateId: replaced[0] ?? null,
        },
        correlationId: context.correlationId,
      });
      return { kind: 'ACTIVATED', replaced };
    });
  }

  /** Valida todos os pendentes da empresa (CLI do operador; o caminho normal é o job `certificates.validate`). */
  async validatePending(companyId: string, context: AuditContext): Promise<ValidationOutcome[]> {
    const ids = await this.uow.inCompany(companyId, (r) => r.certificates.listPendingIds());
    const outcomes: ValidationOutcome[] = [];
    for (const id of ids) outcomes.push(await this.validate(companyId, id, context));
    return outcomes;
  }

  /**
   * Abre o certificado ATIVO do estabelecimento só durante `work` (doc 02 §4). A chave privada
   * nunca sai deste escopo como texto ou bytes; certificado vencido falha ANTES de qualquer envio.
   */
  async withCertificate<T>(companyId: string, establishmentId: string, work: (certificate: CertificateInUse) => Promise<T>): Promise<T> {
    const loaded = await this.uow.inCompany(companyId, (r) => r.certificates.findActive(establishmentId));
    if (loaded?.sealed === undefined || loaded.sealed === null || loaded.metadata === null) {
      throw new BusinessRuleError('CERTIFICATE_NOT_AVAILABLE', 'O estabelecimento não tem certificado ativo.');
    }
    if (this.now().getTime() > loaded.metadata.notAfter.getTime()) {
      throw new BusinessRuleError('CERTIFICATE_EXPIRED', 'O certificado do estabelecimento está vencido.');
    }
    const material = this.opener.open(loaded.sealed, { companyId, certificateId: loaded.id });
    let opened: OpenedCertificate;
    try {
      const read = this.reader.read(material);
      if (!read.ok) throw new InternalError('ACTIVE_CERTIFICATE_UNREADABLE');
      opened = read.value;
    } finally {
      wipe(material);
    }
    return work({ privateKey: opened.privateKey, certificatePem: opened.certificatePem, chainPem: opened.chainPem, thumbprintSha256: opened.metadata.thumbprintSha256 });
  }
}
