import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, request } from 'undici';
import type { SendResult, WebhookRequest, WebhookSender } from '../../application/ports.js';
import { checkWebhookUrl, isPublicIpAddress } from '../../domain/target-policy.js';

export interface WebhookSenderOptions {
  /** Só desenvolvimento e testes: permite http e endereços privados (a config recusa em produção). */
  readonly allowPrivateTargets: boolean;
  readonly timeoutMs: number;
}

class ForbiddenTargetError extends Error {
  readonly code = 'TARGET_FORBIDDEN';
}

/**
 * Resolução de DNS que recusa endereços não públicos. Roda no momento da conexão, então vale
 * para o IP efetivamente usado (protege contra DNS rebinding entre o cadastro e a entrega).
 */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }
    const first = addresses[0];
    if (first === undefined || addresses.some((a) => isPublicIpAddress(a.address) !== true)) {
      callback(new ForbiddenTargetError('destino não público'), '', 0);
      return;
    }
    if (options.all === true) {
      const callbackAll = callback as unknown as (err: null, all: LookupAddress[]) => void;
      callbackAll(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
};

function networkCode(error: unknown): string {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === 'TARGET_FORBIDDEN') return 'TARGET_FORBIDDEN';
  if (error instanceof Error && (error.name === 'AbortError' || /TIMEOUT/i.test(String(code)))) return 'TIMEOUT';
  if (typeof code === 'string' && /CERT|TLS|SSL/i.test(code)) return 'TLS_ERROR';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS_ERROR';
  return 'CONNECTION_FAILED';
}

/**
 * Entrega HTTP dos webhooks (worker-general). Não segue redirecionamentos (3xx = falha), não
 * lê o corpo da resposta e nunca registra a URL completa (pode conter token do cliente).
 */
export class HttpWebhookSender implements WebhookSender {
  private readonly agent: Agent;

  constructor(private readonly options: WebhookSenderOptions) {
    this.agent = new Agent({
      connect: { timeout: options.timeoutMs, ...(options.allowPrivateTargets ? {} : { lookup: publicOnlyLookup }) },
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      connections: 32,
    });
  }

  async send(webhook: WebhookRequest, signal: AbortSignal): Promise<SendResult> {
    const checked = checkWebhookUrl(webhook.url, { allowPrivateTargets: this.options.allowPrivateTargets });
    if (!checked.ok) return { kind: 'NETWORK_ERROR', code: 'TARGET_FORBIDDEN' };
    // IP literal não passa pelo lookup: confere aqui.
    if (!this.options.allowPrivateTargets && isPublicIpAddress(checked.url.hostname) === false) return { kind: 'NETWORK_ERROR', code: 'TARGET_FORBIDDEN' };

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    try {
      const response = await request(checked.url, {
        method: 'POST',
        headers: webhook.headers,
        body: webhook.body,
        dispatcher: this.agent,
        signal: AbortSignal.any([signal, timeout]),
      });
      await response.body.dump({ limit: 64 * 1024 });
      const status = response.statusCode;
      return status >= 200 && status < 300 ? { kind: 'DELIVERED', httpStatus: status } : { kind: 'HTTP_ERROR', httpStatus: status };
    } catch (error) {
      return { kind: 'NETWORK_ERROR', code: networkCode(error) };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
