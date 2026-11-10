/**
 * Calendário público de reentrega de webhooks (ADR-0015, ADR-0026). Publicado no doc 11 e na
 * descrição da API; mudar exige atualizar os dois.
 *
 * Tentativa 1 imediata; depois de cada falha, espera o intervalo da posição correspondente.
 * Total: 8 tentativas em cerca de 22 h 21 min. Esgotadas, a entrega fica FAILED e pode ser
 * reenviada manualmente.
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 10_800, 21_600, 43_200] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Espera até a próxima tentativa depois de `attemptsMade` tentativas falhas; `null` = esgotou. */
export function nextRetryDelaySeconds(attemptsMade: number): number | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) throw new RangeError('attemptsMade deve ser inteiro ≥ 1');
  return RETRY_DELAYS_SECONDS[attemptsMade - 1] ?? null;
}
