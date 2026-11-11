import type { EventOutbox } from '../../../shared/application/outbox.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { expiryNoticeThreshold } from '../domain/certificate.js';

/** O que o worker-general enxerga do certificado: só o necessário para o aviso (grant de coluna). */
export interface CertificateExpiryView {
  readonly id: string;
  readonly establishmentId: string;
  readonly status: string;
  readonly notAfter: Date | null;
}

export interface CertificateExpiryRepositories {
  readonly certificates: { findForExpiry(certificateId: string): Promise<CertificateExpiryView | undefined> };
  /** Registra o aviso do limiar; `false` se já tinha sido dado (repetição do job). */
  readonly notices: { record(certificateId: string, thresholdDays: number): Promise<boolean> };
  readonly events: EventOutbox;
}

export type ExpiryNoticeOutcome =
  | { readonly kind: 'NOTIFIED'; readonly type: 'certificate.expiring' | 'certificate.expired'; readonly thresholdDays: number }
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'NOT_ACTIVE' | 'OUTSIDE_WINDOW' | 'ALREADY_NOTIFIED' };

/**
 * Avisos de vencimento (worker-general, doc 13 §4). Cada certificado ativado agenda os próprios
 * jobs (CertificateVault); aqui só se decide, NA HORA, qual aviso vale. Certificado revogado ou
 * substituído no meio do caminho não gera aviso. Idempotente por (certificado, limiar).
 */
export class CertificateExpiryNotifier {
  constructor(
    private readonly uow: UnitOfWork<CertificateExpiryRepositories>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async notify(companyId: string, certificateId: string, correlationId: string | null): Promise<ExpiryNoticeOutcome> {
    return this.uow.inCompany(companyId, async (r) => {
      const certificate = await r.certificates.findForExpiry(certificateId);
      if (certificate === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' };
      if (certificate.status !== 'ACTIVE' || certificate.notAfter === null) return { kind: 'SKIPPED', reason: 'NOT_ACTIVE' };
      const notice = expiryNoticeThreshold(certificate.notAfter, this.now());
      if (notice === null) return { kind: 'SKIPPED', reason: 'OUTSIDE_WINDOW' };
      if (!(await r.notices.record(certificateId, notice.thresholdDays))) return { kind: 'SKIPPED', reason: 'ALREADY_NOTIFIED' };

      const type = notice.thresholdDays === 0 ? 'certificate.expired' : 'certificate.expiring';
      await r.events.publish({
        type,
        subject: { type: 'certificate', id: certificateId },
        data: {
          certificateId,
          establishmentId: certificate.establishmentId,
          notAfter: certificate.notAfter.toISOString(),
          daysRemaining: notice.daysRemaining,
          thresholdDays: notice.thresholdDays,
        },
        correlationId,
      });
      return { kind: 'NOTIFIED', type, thresholdDays: notice.thresholdDays };
    });
  }
}
