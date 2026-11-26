import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Máquina de estados da NFC-e (ADR-0072), no molde da NFS-e (ADR-0032), com duas diferenças:
 *
 * - `DENIED`: denegação de uso grava a nota no autorizador (MOC 7.0, item 5.1.6). É final e o
 *   número fica consumido; não é rejeição.
 * - Cada tentativa monta e assina um XML novo, com `dhEmi` no momento do envio: a NFC-e normal tem de
 *   chegar à SEFAZ até 5 minutos depois do `dhEmi` (regra B09-40, NT 2026.002 v1.11). Por isso uma
 *   nova tentativa só nasce quando está PROVADO que as anteriores não geraram nota.
 *
 * As mesmas transições são conferidas por trigger no banco (migration de segurança da NFC-e).
 */
export const CONSUMER_INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'DENIED', 'FAILED', 'UNKNOWN'] as const;
export type ConsumerInvoiceStatus = (typeof CONSUMER_INVOICE_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ConsumerInvoiceStatus, readonly ConsumerInvoiceStatus[]>> = {
  PENDING: ['PROCESSING', 'FAILED'],
  // PENDING: nada saiu (NOT_SENT ou queda com a tentativa só PREPARED); FAILED: falha local antes de qualquer envio.
  PROCESSING: ['AUTHORIZED', 'REJECTED', 'DENIED', 'UNKNOWN', 'PENDING', 'FAILED'],
  // A consulta pela chave resolve: autorizada, denegada, ou inexistente provada (volta a PENDING).
  UNKNOWN: ['AUTHORIZED', 'DENIED', 'PENDING'],
  AUTHORIZED: [],
  REJECTED: [],
  DENIED: [],
  FAILED: [],
};

export function canTransition(from: ConsumerInvoiceStatus, to: ConsumerInvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface InvalidTransition {
  readonly code: 'INVALID_TRANSITION';
  readonly from: ConsumerInvoiceStatus;
  readonly to: ConsumerInvoiceStatus;
}

export function transition(from: ConsumerInvoiceStatus, to: ConsumerInvoiceStatus): Result<ConsumerInvoiceStatus, InvalidTransition> {
  return canTransition(from, to) ? ok(to) : err({ code: 'INVALID_TRANSITION', from, to });
}

export function isFinal(status: ConsumerInvoiceStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** A `externalReference` só volta a ficar livre depois de falha definitiva sem nota no autorizador. */
export function releasesExternalReference(status: ConsumerInvoiceStatus): boolean {
  return status === 'REJECTED' || status === 'FAILED';
}

/** Tentativa de transmissão (write-ahead, ADR-0022): PREPARED → SENDING → CLOSED. */
export type AttemptState = 'PREPARED' | 'SENDING' | 'CLOSED';

export const ATTEMPT_OUTCOMES = ['AUTHORIZED', 'REJECTED', 'DENIED', 'NOT_SENT', 'UNKNOWN', 'ALREADY_EXISTS', 'RECOVERED_NOT_SENT', 'RECOVERED_UNKNOWN'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * Queda com a concessão vencida (doc 12 §2): PREPARED = certeza de que nada saiu; SENDING = pode ter
 * saído. Sem tentativa aberta, a queda foi antes do write-ahead.
 */
export type StuckRecovery = { readonly kind: 'BACK_TO_PENDING' } | { readonly kind: 'TO_UNKNOWN' };

export function recoverStuck(openAttempt: AttemptState | null): StuckRecovery {
  return openAttempt === 'SENDING' ? { kind: 'TO_UNKNOWN' } : { kind: 'BACK_TO_PENDING' };
}
