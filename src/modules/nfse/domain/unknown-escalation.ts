/**
 * Escalonamento de NFS-e em UNKNOWN pela idade (doc 12 §6, ADR-0034 item 5).
 *
 * | Idade     | Nível      |
 * |-----------|------------|
 * | > 15 min  | WARNING    |
 * | > 2 h     | CRITICAL   |
 * | > 24 h    | INCIDENT, repetido a cada 24 h enquanto não resolver |
 *
 * A idade conta do envio da tentativa que ficou sem resposta. O alerta não muda o documento:
 * a única saída de UNKNOWN continua sendo a consulta ao autorizador ou a resolução manual.
 */
export type EscalationLevel = 'WARNING' | 'CRITICAL' | 'INCIDENT';

export interface EscalationPolicy {
  readonly warningAfterMs: number;
  readonly criticalAfterMs: number;
  readonly incidentAfterMs: number;
  /** Depois do incidente, o alerta se repete neste intervalo. */
  readonly incidentRepeatMs: number;
}

const MIN = 60_000;
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  warningAfterMs: 15 * MIN,
  criticalAfterMs: 120 * MIN,
  incidentAfterMs: 24 * 60 * MIN,
  incidentRepeatMs: 24 * 60 * MIN,
};

/** Nível para a idade, ou `undefined` antes do primeiro limite. */
export function escalationLevel(ageMs: number, policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY): EscalationLevel | undefined {
  if (ageMs >= policy.incidentAfterMs) return 'INCIDENT';
  if (ageMs >= policy.criticalAfterMs) return 'CRITICAL';
  if (ageMs >= policy.warningAfterMs) return 'WARNING';
  return undefined;
}

/** Próxima verificação: o próximo limite ainda não atingido, ou a próxima repetição do incidente. */
export function nextEscalationAt(since: Date, now: Date, policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY): Date {
  const age = now.getTime() - since.getTime();
  for (const limit of [policy.warningAfterMs, policy.criticalAfterMs, policy.incidentAfterMs]) {
    if (age < limit) return new Date(since.getTime() + limit);
  }
  const repeats = Math.floor((age - policy.incidentAfterMs) / policy.incidentRepeatMs) + 1;
  return new Date(since.getTime() + policy.incidentAfterMs + repeats * policy.incidentRepeatMs);
}
