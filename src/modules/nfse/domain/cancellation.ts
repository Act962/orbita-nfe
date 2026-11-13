import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Cancelamento de NFS-e pelo evento e101101 (ADR-0035). Mesma disciplina da emissão:
 * FAILED só com certeza de não envio; dúvida depois de um possível envio é UNKNOWN; de UNKNOWN
 * só se sai por consulta ao autorizador. Também conferido por trigger no banco.
 */
export const CANCELLATION_STATES = ['PENDING', 'PROCESSING', 'REGISTERED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
export type CancellationState = (typeof CANCELLATION_STATES)[number];

const TRANSITIONS: Readonly<Record<CancellationState, readonly CancellationState[]>> = {
  PENDING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['REGISTERED', 'REJECTED', 'UNKNOWN', 'PENDING', 'FAILED'],
  UNKNOWN: ['REGISTERED', 'PENDING'],
  REGISTERED: [],
  REJECTED: [],
  FAILED: [],
};

export function canTransitionCancellation(from: CancellationState, to: CancellationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados que liberam um novo pedido de cancelamento para a mesma nota. */
export function allowsNewCancellation(state: CancellationState): boolean {
  return state === 'REJECTED' || state === 'FAILED';
}

/** Tipo do evento de cancelamento (TCInfPedReg, grupo e101101). */
export const CANCELLATION_EVENT_TYPE = '101101';

/**
 * `nSeqEvento` do cancelamento: "Para os eventos que ocorrem somente uma vez, como é o caso do
 * cancelamento, o nSeqEvento = 001" (Anexo II v1.01 de 22/01/2026, aba LEIAUTE, campo nSeqEvento).
 */
export const CANCELLATION_EVENT_SEQUENCE = 1;

/** TSCodJustCanc: 1 Erro na Emissão; 2 Serviço não Prestado; 9 Outros. */
export const CANCELLATION_REASON_CODES = ['1', '2', '9'] as const;
export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

/** TSMotivo: de 15 a 255 caracteres. */
export const REASON_TEXT_MIN = 15;
export const REASON_TEXT_MAX = 255;

/**
 * `@Id` do pedido de registro de evento (TSIdPedRegEvt): "PRE" + chave de acesso (50) + tipo do
 * evento (6). A documentação do tipo cita também `nPedRegEvento`, que não cabe no padrão nem existe
 * como elemento na v1.01 (ADR-0035 item 6, R-40).
 *
 * Aqui só a forma geral (50 posições, dígitos ou letras maiúsculas): os padrões exatos divergem
 * entre os pacotes (a produção restrita aceita CNPJ alfanumérico) e quem decide é o XSD do pacote.
 */
export function pedRegEventoId(accessKey: string): Result<string, 'ACCESS_KEY_INVALID'> {
  if (!/^[0-9A-Z]{50}$/.test(accessKey)) return err('ACCESS_KEY_INVALID');
  return ok(`PRE${accessKey}${CANCELLATION_EVENT_TYPE}`);
}
