import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';
import type { KeyObject } from 'node:crypto';
import { Agent, request } from 'undici';

/**
 * Transporte mTLS que informa a FASE em que uma falha ocorreu (docs/architecture/12 §2).
 *
 * Regra de segurança: só é NOT_SENT se for comprovado que nenhum byte da requisição HTTP
 * foi escrito no socket. Qualquer dúvida → UNKNOWN.
 */
export type TransportPhase = 'connect' | 'request-write' | 'response-wait' | 'response-read';

export type TransportOutcome =
  | { kind: 'RESPONSE'; status: number; body: string }
  | { kind: 'NOT_SENT'; phase: 'connect'; errorCode: string }
  | { kind: 'UNKNOWN'; phase: TransportPhase; errorCode: string };

interface Trace {
  headersSent: boolean;
  bodySent: boolean;
  responseHeaders: boolean;
}

// Correlação request do undici → nosso trace. `undici:request:create` é publicado de forma
// síncrona dentro de `dispatch`, ainda no contexto assíncrono de quem chamou.
const context = new AsyncLocalStorage<Trace>();
const traces = new WeakMap<object, Trace>();
let subscribed = false;

function subscribeOnce(): void {
  if (subscribed) return;
  subscribed = true;
  diagnosticsChannel.subscribe('undici:request:create', (message) => {
    const trace = context.getStore();
    if (trace) traces.set((message as { request: object }).request, trace);
  });
  diagnosticsChannel.subscribe('undici:client:sendHeaders', (message) => {
    const trace = traces.get((message as { request: object }).request);
    if (trace) trace.headersSent = true;
  });
  diagnosticsChannel.subscribe('undici:request:bodyChunkSent', (message) => {
    const trace = traces.get((message as { request: object }).request);
    if (trace) trace.headersSent = true;
  });
  diagnosticsChannel.subscribe('undici:request:bodySent', (message) => {
    const trace = traces.get((message as { request: object }).request);
    if (trace) trace.bodySent = true;
  });
  diagnosticsChannel.subscribe('undici:request:headers', (message) => {
    const trace = traces.get((message as { request: object }).request);
    if (trace) trace.responseHeaders = true;
  });
}

export interface MtlsIdentity {
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
  /** ACs confiáveis para o servidor (bundle ICP-Brasil em produção). Nunca desativar a verificação. */
  readonly trustedCaPem: string;
}

export interface Timeouts {
  readonly connectMs: number;
  readonly headersMs: number;
  readonly bodyMs: number;
}

export function createMtlsAgent(identity: MtlsIdentity, timeouts: Timeouts): Agent {
  return new Agent({
    connect: {
      key: identity.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      cert: identity.certificatePem,
      ca: identity.trustedCaPem,
      rejectUnauthorized: true,
      timeout: timeouts.connectMs,
    },
    headersTimeout: timeouts.headersMs,
    bodyTimeout: timeouts.bodyMs,
    // Uma requisição por conexão em voo: evita ambiguidades de pipelining.
    pipelining: 1,
  });
}

export async function postOnce(agent: Agent, url: string, body: string, contentType: string): Promise<TransportOutcome> {
  subscribeOnce();
  const trace: Trace = { headersSent: false, bodySent: false, responseHeaders: false };
  try {
    const response = await context.run(trace, () =>
      request(url, { method: 'POST', body, headers: { 'content-type': contentType }, dispatcher: agent }),
    );
    try {
      const text = await response.body.text();
      return { kind: 'RESPONSE', status: response.statusCode, body: text };
    } catch (error) {
      return { kind: 'UNKNOWN', phase: 'response-read', errorCode: codeOf(error) };
    }
  } catch (error) {
    return classify(trace, error);
  }
}

function classify(trace: Trace, error: unknown): TransportOutcome {
  const errorCode = codeOf(error);
  if (!trace.headersSent) return { kind: 'NOT_SENT', phase: 'connect', errorCode };
  if (trace.responseHeaders) return { kind: 'UNKNOWN', phase: 'response-read', errorCode };
  if (trace.bodySent) return { kind: 'UNKNOWN', phase: 'response-wait', errorCode };
  return { kind: 'UNKNOWN', phase: 'request-write', errorCode };
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (typeof cause?.code === 'string') return cause.code;
  }
  return 'UNKNOWN_ERROR';
}
