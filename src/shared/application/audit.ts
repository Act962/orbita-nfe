import type { AuditActor, AuditDetails } from '../domain/audit.js';

export type { AuditActor, AuditDetails, AuditValue } from '../domain/audit.js';

/**
 * Porta da trilha de auditoria (docs/architecture/14 §A4, 09 §5). Implementada pelo módulo
 * `audit`; os módulos de negócio recebem um `AuditTrail` ligado à MESMA transação da mudança,
 * então mudança e registro são gravados juntos ou nenhum dos dois.
 */

/** Catálogo fechado de ações auditadas. Ação nova entra aqui e no doc 09 §5. */
export const COMPANY_AUDIT_ACTIONS = [
  'company.registered',
  'establishment.registered',
  'document_series.created',
  'company_grant.granted',
  'company_grant.revoked',
  'certificate.uploaded',
  'certificate.activated',
  'certificate.rejected',
  'certificate.replaced',
  'certificate.revoked',
  'webhook_subscription.created',
  'webhook_subscription.updated',
  'webhook_subscription.secret_rotated',
  'webhook_delivery.redelivered',
  'production_enablement.granted',
  'production_enablement.revoked',
  'service_invoice.accepted',
  'service_invoice.authorized',
  'service_invoice.rejected',
  'service_invoice.failed',
  'service_invoice.unknown',
  'service_invoice.retransmission_scheduled',
  'service_invoice.resolution_requested',
  'service_invoice.resolution_applied',
  'service_invoice.resolution_refused',
  'service_invoice.cancellation_requested',
  'service_invoice.cancelled',
  'service_invoice.cancellation_rejected',
  'service_invoice.cancellation_failed',
  'service_invoice.cancellation_unknown',
  'service_invoice.cancellation_retransmission_scheduled',
] as const;
export type CompanyAuditAction = (typeof COMPANY_AUDIT_ACTIONS)[number];

/** Ações do operador que não pertencem a uma empresa (cadeia da plataforma). */
export const PLATFORM_AUDIT_ACTIONS = [
  'client_application.created',
  'credential.issued',
  'credential.revoked',
  'queue.paused',
  'queue.resumed',
  'job.retried',
  'job.discarded',
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

/** Quem fez e em qual requisição (correlation id), quando houver. */
export interface AuditContext {
  readonly actor: AuditActor;
  readonly correlationId: string | null;
}

export interface AuditRecord<A extends string = CompanyAuditAction> {
  readonly action: A;
  readonly subject: { readonly type: string; readonly id: string };
  readonly details?: AuditDetails;
}

/** Trilha da empresa do contexto da transação. */
export interface AuditTrail {
  record(context: AuditContext, record: AuditRecord): Promise<void>;
}

/** Trilha da plataforma (operador). */
export interface PlatformAuditTrail {
  record(context: AuditContext, record: AuditRecord<PlatformAuditAction>): Promise<void>;
}

/** O ator é uma aplicação cliente (rotas da API). */
export function clientApplicationOf(context: AuditContext): string | undefined {
  return context.actor.kind === 'CLIENT_APPLICATION' ? context.actor.clientApplicationId : undefined;
}
