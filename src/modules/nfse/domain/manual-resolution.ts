import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Resolução manual de NFS-e em UNKNOWN (doc 12 §7, ADR-0034).
 *
 * - `AUTHORIZED`: o operador obteve no portal oficial o XML da NFS-e. O worker-fiscal confere o XML
 *   (XSD oficial, Id da DPS, ambiente, assinatura da DPS) antes de dar a nota como autorizada.
 * - `NOT_ISSUED`: o operador confirmou que a nota não existe. O documento volta a PENDING e o
 *   MESMO XML assinado é retransmitido. Se a nota existir lá, o autorizador responde duplicidade
 *   e a consulta resolve. Nunca há outro número nem FAILED.
 *
 * A resolução é um pedido gravado e auditado. Quem muda o estado é só o worker-fiscal.
 */
export const RESOLUTION_OUTCOMES = ['AUTHORIZED', 'NOT_ISSUED'] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export type ResolutionState = 'REQUESTED' | 'APPLIED' | 'REFUSED';

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;

export type ResolutionInputError = 'OUTCOME_INVALID' | 'REASON_TOO_SHORT' | 'REASON_TOO_LONG' | 'NFSE_XML_REQUIRED' | 'NFSE_XML_NOT_ALLOWED';

export function isResolutionOutcome(value: string): value is ResolutionOutcome {
  return (RESOLUTION_OUTCOMES as readonly string[]).includes(value);
}

/** Regras do pedido, antes de gravar. A conferência do XML é do worker-fiscal. */
export function checkResolutionInput(input: { outcome: string; reason: string; nfseXml: string | null }): Result<ResolutionOutcome, ResolutionInputError> {
  if (!isResolutionOutcome(input.outcome)) return err('OUTCOME_INVALID');
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN_LENGTH) return err('REASON_TOO_SHORT');
  if (reason.length > REASON_MAX_LENGTH) return err('REASON_TOO_LONG');
  if (input.outcome === 'AUTHORIZED' && (input.nfseXml === null || input.nfseXml.trim() === '')) return err('NFSE_XML_REQUIRED');
  if (input.outcome === 'NOT_ISSUED' && input.nfseXml !== null) return err('NFSE_XML_NOT_ALLOWED');
  return ok(input.outcome);
}

/**
 * Último resultado de envio que impede `NOT_ISSUED`: o próprio autorizador disse que a DPS
 * existe (duplicidade). Só a consulta, ou o XML oficial, resolve esse caso.
 */
export function blocksNotIssued(lastAttemptOutcome: string | null): boolean {
  return lastAttemptOutcome === 'ALREADY_EXISTS';
}
