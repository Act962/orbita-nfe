/**
 * Decisão da reconciliação de um documento `UNKNOWN` (doc 12 §3, ADR-0022, ADR-0032).
 *
 * Função pura: recebe o histórico de consultas da tentativa em dúvida e devolve o próximo passo.
 * Os tempos são técnicos (não fiscais) e configuráveis; os valores iniciais vêm do doc 12 e
 * devem ser ajustados por medição na produção restrita.
 */
export interface ReconciliationPolicy {
  /** Espera mínima depois do SENDING antes da 1ª consulta. */
  readonly minWaitAfterSendingMs: number;
  /** Intervalo mínimo entre a 1ª e a 2ª resposta "não encontrado". */
  readonly secondNotFoundAfterMs: number;
  /** Esperas depois de consultas com erro: 1, 2, 5, 10, 30 min; depois, a última se repete. */
  readonly errorBackoffMs: readonly number[];
}

const MINUTE = 60_000;

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = {
  minWaitAfterSendingMs: 2 * MINUTE,
  secondNotFoundAfterMs: 5 * MINUTE,
  errorBackoffMs: [1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE, 60 * MINUTE],
};

export interface ReconciliationState {
  readonly sendingAt: Date;
  /** Instante da 1ª resposta "não encontrado" desta tentativa, se houve. */
  readonly firstNotFoundAt: Date | null;
  /** Consultas com erro seguidas (zera quando uma consulta responde). */
  readonly consecutiveLookupErrors: number;
}

export type LookupResult = { readonly kind: 'FOUND' } | { readonly kind: 'NOT_FOUND' } | { readonly kind: 'ERROR' };

export type ReconciliationStep =
  /** Ainda não é hora de consultar. */
  | { readonly kind: 'WAIT_UNTIL'; readonly at: Date }
  /** Consultar agora. */
  | { readonly kind: 'LOOKUP' };

/** Antes de consultar: respeita a espera mínima depois do SENDING. */
export function nextStep(state: ReconciliationState, now: Date, policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY): ReconciliationStep {
  const earliest = state.sendingAt.getTime() + policy.minWaitAfterSendingMs;
  return now.getTime() < earliest ? { kind: 'WAIT_UNTIL', at: new Date(earliest) } : { kind: 'LOOKUP' };
}

export type LookupDecision =
  | { readonly kind: 'AUTHORIZED' }
  /** 2ª resposta "não encontrado" espaçada: provado que não existe → retransmitir o MESMO XML. */
  | { readonly kind: 'RETRANSMIT' }
  | { readonly kind: 'CONSULT_AGAIN_AT'; readonly at: Date; readonly state: ReconciliationState };

/** Depois de uma consulta: decide e devolve o novo estado da reconciliação. */
export function afterLookup(
  state: ReconciliationState,
  result: LookupResult,
  now: Date,
  policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
): LookupDecision {
  if (result.kind === 'FOUND') return { kind: 'AUTHORIZED' };
  if (result.kind === 'ERROR') {
    const errors = state.consecutiveLookupErrors + 1;
    const wait = policy.errorBackoffMs[Math.min(errors, policy.errorBackoffMs.length) - 1] ?? MINUTE;
    return { kind: 'CONSULT_AGAIN_AT', at: new Date(now.getTime() + wait), state: { ...state, consecutiveLookupErrors: errors } };
  }
  const reset = { ...state, consecutiveLookupErrors: 0 };
  if (state.firstNotFoundAt === null) {
    return { kind: 'CONSULT_AGAIN_AT', at: new Date(now.getTime() + policy.secondNotFoundAfterMs), state: { ...reset, firstNotFoundAt: now } };
  }
  const secondAllowedAt = state.firstNotFoundAt.getTime() + policy.secondNotFoundAfterMs;
  if (now.getTime() < secondAllowedAt) {
    // "Não encontrado" cedo demais não conta como 2ª prova: consulta de novo no tempo certo.
    return { kind: 'CONSULT_AGAIN_AT', at: new Date(secondAllowedAt), state: reset };
  }
  return { kind: 'RETRANSMIT' };
}
