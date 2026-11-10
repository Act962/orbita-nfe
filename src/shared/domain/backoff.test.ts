import { describe, expect, it } from 'vitest';
import { retryDelaySeconds } from './backoff.js';
import { takeToken } from './token-bucket.js';

const policy = { baseSeconds: 30, maxSeconds: 1800, jitter: 0.2 };

describe('backoff exponencial com teto e jitter', () => {
  it('dobra a cada falha até o teto (sem jitter no centro)', () => {
    const middle = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => retryDelaySeconds(n, policy, middle))).toEqual([30, 60, 120, 240, 480, 960, 1800, 1800]);
  });

  it('jitter fica dentro de ±20% e nunca passa do teto', () => {
    expect(retryDelaySeconds(1, policy, () => 0)).toBe(24);
    expect(retryDelaySeconds(1, policy, () => 0.999999)).toBe(36);
    expect(retryDelaySeconds(30, policy, () => 0.999999)).toBe(1800);
  });

  it('nunca devolve menos de 1 segundo e recusa contagem inválida', () => {
    expect(retryDelaySeconds(1, { baseSeconds: 0.1, maxSeconds: 1, jitter: 0 })).toBe(1);
    expect(() => retryDelaySeconds(0, policy)).toThrow(RangeError);
    expect(() => retryDelaySeconds(1.5, policy)).toThrow(RangeError);
  });
});

describe('balde de fichas (rate limit)', () => {
  const bucket = { capacity: 3, refillPerSecond: 1 };

  it('permite a rajada e depois recusa, informando quando tentar de novo', () => {
    let state;
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = takeToken(bucket, state, 1_000);
      state = r.state;
      results.push(r);
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]?.retryAfterSeconds).toBe(1);
    expect(results[3]?.resetSeconds).toBe(3);
  });

  it('repõe fichas com o tempo, sem passar da capacidade', () => {
    const empty = { tokens: 0, updatedAtMs: 0 };
    expect(takeToken(bucket, empty, 1_500).allowed).toBe(true);
    expect(takeToken(bucket, empty, 500).allowed).toBe(false);
    expect(takeToken(bucket, empty, 60_000).remaining).toBe(2);
  });
});
