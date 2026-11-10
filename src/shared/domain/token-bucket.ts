/** Balde de fichas (token bucket) para limite de requisições (ADR-0026). Puro e determinístico. */
export interface BucketPolicy {
  /** Fichas máximas (rajada permitida). */
  readonly capacity: number;
  /** Fichas repostas por segundo. */
  readonly refillPerSecond: number;
}

export interface BucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export interface TakeResult {
  readonly allowed: boolean;
  readonly state: BucketState;
  /** Fichas inteiras restantes depois desta requisição. */
  readonly remaining: number;
  /** Segundos até haver 1 ficha (0 se já há). */
  readonly retryAfterSeconds: number;
  /** Segundos até o balde encher de novo. */
  readonly resetSeconds: number;
}

export function takeToken(policy: BucketPolicy, previous: BucketState | undefined, nowMs: number): TakeResult {
  const elapsed = previous === undefined ? 0 : Math.max(0, nowMs - previous.updatedAtMs) / 1000;
  const available = previous === undefined ? policy.capacity : Math.min(policy.capacity, previous.tokens + elapsed * policy.refillPerSecond);
  const allowed = available >= 1;
  const tokens = allowed ? available - 1 : available;
  const missing = policy.capacity - tokens;
  return {
    allowed,
    state: { tokens, updatedAtMs: nowMs },
    remaining: Math.floor(tokens),
    retryAfterSeconds: allowed ? 0 : Math.ceil((1 - tokens) / policy.refillPerSecond),
    resetSeconds: Math.ceil(missing / policy.refillPerSecond),
  };
}
