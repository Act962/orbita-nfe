/** Política de espera entre tentativas: exponencial com teto e jitter (docs/architecture/07 §3). */
export interface BackoffPolicy {
  /** Espera depois da 1ª falha, em segundos. */
  readonly baseSeconds: number;
  /** Teto da espera, em segundos. */
  readonly maxSeconds: number;
  /** Fração de variação aleatória (0 a 1). 0,2 = ±20%. */
  readonly jitter: number;
}

/**
 * Segundos até a próxima tentativa depois de `failedAttempts` falhas (≥ 1).
 * `random` devolve um número em [0, 1); injetável para teste.
 */
export function retryDelaySeconds(failedAttempts: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) throw new RangeError('failedAttempts deve ser inteiro ≥ 1');
  const exponential = Math.min(policy.maxSeconds, policy.baseSeconds * 2 ** Math.min(failedAttempts - 1, 30));
  const spread = exponential * policy.jitter;
  const jittered = exponential - spread + random() * 2 * spread;
  return Math.max(1, Math.round(Math.min(policy.maxSeconds, jittered)));
}
