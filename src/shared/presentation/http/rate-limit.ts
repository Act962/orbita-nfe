import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitedError } from '../../application/errors.js';
import { takeToken, type BucketPolicy, type BucketState } from '../../domain/token-bucket.js';
import type { HttpApp } from './http-app.js';

export interface RateLimitOptions {
  /** Por credencial autenticada. */
  readonly perCredential: BucketPolicy;
  /** Por endereço de origem, antes da autenticação (freia força bruta de credenciais). */
  readonly perAddress: BucketPolicy;
  /** Teto de chaves em memória (as mais antigas saem primeiro). */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

/**
 * Baldes em memória do processo (ADR-0026). Com uma réplica da API isso é exato; com N réplicas
 * o limite efetivo vira N × o configurado (documentado no runbook; Redis fica para quando houver
 * mais de uma réplica, ADR-0020).
 */
class BucketStore {
  private readonly buckets = new Map<string, BucketState>();
  constructor(private readonly maxKeys: number) {}

  take(key: string, policy: BucketPolicy, nowMs: number) {
    const result = takeToken(policy, this.buckets.get(key), nowMs);
    this.buckets.delete(key);
    this.buckets.set(key, result.state);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return result;
  }
}

function setHeaders(reply: FastifyReply, policy: BucketPolicy, result: { remaining: number; resetSeconds: number }): void {
  void reply.header('ratelimit-limit', String(policy.capacity));
  void reply.header('ratelimit-remaining', String(result.remaining));
  void reply.header('ratelimit-reset', String(result.resetSeconds));
}

const limited = (route: FastifyRequest['routeOptions']): boolean => {
  const auth = route.config.auth;
  return auth !== undefined && !('public' in auth);
};

/**
 * Limite de requisições (ADR-0026): 429 + `Retry-After` + `RateLimit-*`.
 *
 * Ordem no composition root: `beforeAuthentication` → registerAuthentication → `afterAuthentication`
 * → rotas. Os dois limites rodam em `onRequest`, antes de ler o corpo.
 */
export class RateLimiter {
  private readonly store: BucketStore;
  private readonly now: () => number;

  constructor(private readonly options: RateLimitOptions) {
    this.store = new BucketStore(options.maxKeys ?? 50_000);
    this.now = options.now ?? Date.now;
  }

  /** Por endereço de origem: vale também para quem ainda não se autenticou. */
  beforeAuthentication(app: HttpApp): void {
    app.addHook('onRequest', async (request, reply) => {
      if (!limited(request.routeOptions)) return;
      const result = this.store.take(`ip:${request.ip}`, this.options.perAddress, this.now());
      if (!result.allowed) {
        setHeaders(reply, this.options.perAddress, result);
        throw new RateLimitedError(result.retryAfterSeconds);
      }
    });
  }

  /** Por credencial: a identidade já foi conferida pelo hook de autenticação. */
  afterAuthentication(app: HttpApp): void {
    app.addHook('onRequest', async (request, reply) => {
      if (!limited(request.routeOptions) || request.caller === null) return;
      const result = this.store.take(`cred:${request.caller.credentialRef}`, this.options.perCredential, this.now());
      setHeaders(reply, this.options.perCredential, result);
      if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    });
  }
}
