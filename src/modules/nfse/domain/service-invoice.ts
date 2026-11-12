import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Máquina de estados da NFS-e (doc 04 §3, ADR-0006, ADR-0032).
 *
 * - `FAILED` só quando é CERTO que nada foi transmitido.
 * - Qualquer dúvida depois de um possível envio é `UNKNOWN`, e a única saída automática de
 *   `UNKNOWN` é uma consulta ao autorizador.
 *
 * As mesmas transições são conferidas por trigger no banco (migration de segurança do nfse).
 */
export const SERVICE_INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export type ServiceInvoiceStatus = (typeof SERVICE_INVOICE_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ServiceInvoiceStatus, readonly ServiceInvoiceStatus[]>> = {
  PENDING: ['PROCESSING', 'FAILED'],
  // PENDING: erro comprovadamente antes do envio, ou queda com a tentativa só PREPARED.
  PROCESSING: ['AUTHORIZED', 'REJECTED', 'UNKNOWN', 'PENDING', 'FAILED'],
  // PENDING: a consulta provou a inexistência (duas vezes) e o MESMO XML será retransmitido.
  UNKNOWN: ['AUTHORIZED', 'PENDING'],
  // CANCELLED: evento de cancelamento registrado no autorizador (ADR-0035).
  AUTHORIZED: ['CANCELLED'],
  CANCELLED: [],
  REJECTED: [],
  FAILED: [],
};

export function canTransition(from: ServiceInvoiceStatus, to: ServiceInvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface InvalidTransition {
  readonly code: 'INVALID_TRANSITION';
  readonly from: ServiceInvoiceStatus;
  readonly to: ServiceInvoiceStatus;
}

export function transition(from: ServiceInvoiceStatus, to: ServiceInvoiceStatus): Result<ServiceInvoiceStatus, InvalidTransition> {
  return canTransition(from, to) ? ok(to) : err({ code: 'INVALID_TRANSITION', from, to });
}

/** Estados em que a `externalReference` pode ser reutilizada (ADR-0026 item 1): falha definitiva. */
export function releasesExternalReference(status: ServiceInvoiceStatus): boolean {
  return status === 'REJECTED' || status === 'FAILED';
}

/**
 * Estado sem saída. Observação: PROCESSING → FAILED só é usado antes de qualquer tentativa
 * chegar a SENDING (L5 ou preparação local); a aplicação garante isso.
 */
export function isFinal(status: ServiceInvoiceStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Estado de uma tentativa de transmissão (write-ahead, ADR-0022). */
export type AttemptState = 'PREPARED' | 'SENDING' | 'CLOSED';

/**
 * O que fazer com um documento `PROCESSING` cuja concessão venceu (o processo caiu).
 * Tabela do doc 12 §2: PREPARED = certeza de não envio; SENDING = pode ter sido enviado.
 * Sem tentativa aberta: a queda foi antes do write-ahead, nada saiu.
 */
export type StuckRecovery = { readonly kind: 'BACK_TO_PENDING' } | { readonly kind: 'TO_UNKNOWN' };

export function recoverStuck(openAttempt: AttemptState | null): StuckRecovery {
  return openAttempt === 'SENDING' ? { kind: 'TO_UNKNOWN' } : { kind: 'BACK_TO_PENDING' };
}
