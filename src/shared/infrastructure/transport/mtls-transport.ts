import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';
import type { KeyObject } from 'node:crypto';
import { Agent, request } from 'undici';

/**
 * Transporte HTTPS com certificado de cliente (mTLS) que informa a FASE em que uma falha ocorreu
 * (ADR-0022, doc 12 §2; promovido do spike 02).
 *
 * Regra de segurança: só é `NOT_SENT` quando está provado que nenhum byte da requisição foi
 * escrito no socket (o canal `undici:client:sendHeaders` não disparou para ela). Qualquer dúvida,
 * inclusive falta de correlação, vira `UNKNOWN`. Um `UNKNOWN` nunca é tratado como "não emitida":
 * quem decide é a reconciliação.
 *
 * Achado do spike 02: em TLS 1.3, quando o servidor recusa o certificado do cliente, a requisição
 * já pode ter saído. Por isso o certificado é validado localmente antes do envio (L5).
 */
export type TransportPhase = 'connect' | 'request-write' | 'response-wait' | 'response-read';

export type TransportOutcome =
  | { readonly kind: 'RESPONSE'; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }
  | { readonly kind: 'NOT_SENT'; readonly phase: 'connect'; readonly errorCode: string }
  | { readonly kind: 'UNKNOWN'; readonly phase: TransportPhase; readonly errorCode: string };

interface Trace {
  /** A requisição do undici foi ligada a este trace. Sem isso, nada se prova: `UNKNOWN`. */
  correlated: boolean;
  headersSent: boolean;
  bodySent: boolean;
  responseHeaders: boolean;
}

// `undici:request:create` é publicado de forma síncrona dentro de `dispatch`, ainda no contexto
// assíncrono de quem chamou: é ali que a requisição do undici é ligada ao nosso trace.
const context = new AsyncLocalStorage<Trace>();
const traces = new WeakMap<object, Trace>();
let subscribed = false;

function traceOf(message: unknown): Trace | undefined {
  return traces.get((message as { request: object }).request);
}

function subscribeOnce(): void {
  if (subscribed) return;
  subscribed = true;
  diagnosticsChannel.subscribe('undici:request:create', (message) => {
    const trace = context.getStore();
    if (trace) {
      trace.correlated = true;
      traces.set((message as { request: object }).request, trace);
    }
  });
  const markSent = (message: unknown) => {
    const trace = traceOf(message);
    if (trace) trace.headersSent = true;
  };
  diagnosticsChannel.subscribe('undici:client:sendHeaders', markSent);
  diagnosticsChannel.subscribe('undici:request:bodyChunkSent', markSent);
  diagnosticsChannel.subscribe('undici:request:bodySent', (message) => {
    const trace = traceOf(message);
    if (trace) trace.bodySent = true;
  });
  diagnosticsChannel.subscribe('undici:request:headers', (message) => {
    const trace = traceOf(message);
    if (trace) trace.responseHeaders = true;
  });
}

export interface MtlsIdentity {
  /** Vem de `CertificateVault.withCertificate`: só existe no worker-fiscal (ADR-0021). */
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
  /**
   * ACs confiáveis para o certificado do SERVIDOR. Ausente = repositório padrão do Node.
   * A verificação do servidor nunca é desligada.
   */
  readonly serverTrustPem?: string;
}

export interface TransportLimits {
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  /** Corpo de resposta acima disso vira `UNKNOWN/response-read` (proteção de memória). */
  readonly maxResponseBytes: number;
}

/**
 * Cria o agente com a chave em `key` + `cert` separados, nunca `pfx` (ADR-0014, regra 1: o
 * OpenSSL 3 do Node recusa PFX legado). A chave vira PEM só dentro do contexto TLS do agente.
 */
export function createMtlsAgent(identity: MtlsIdentity, limits: TransportLimits): Agent {
  return new Agent({
    connect: {
      key: identity.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      cert: identity.certificatePem,
      ...(identity.serverTrustPem === undefined ? {} : { ca: identity.serverTrustPem }),
      rejectUnauthorized: true,
      timeout: limits.connectTimeoutMs,
    },
    headersTimeout: limits.headersTimeoutMs,
    bodyTimeout: limits.bodyTimeoutMs,
    // Uma requisição por conexão em voo: evita ambiguidade de pipelining.
    pipelining: 1,
  });
}

export interface TransportRequest {
  readonly method: 'GET' | 'HEAD' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Uma única tentativa, sem retentativa automática: repetir um envio é decisão da aplicação,
 * depois da reconciliação.
 */
export async function sendOnce(agent: Agent, req: TransportRequest, limits: Pick<TransportLimits, 'maxResponseBytes'>): Promise<TransportOutcome> {
  subscribeOnce();
  const trace: Trace = { correlated: false, headersSent: false, bodySent: false, responseHeaders: false };
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await context.run(trace, () =>
      request(req.url, {
        method: req.method,
        dispatcher: agent,
        ...(req.headers === undefined ? {} : { headers: { ...req.headers } }),
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
  } catch (error) {
    return classify(trace, error);
  }
  try {
    const body = await readLimited(response.body, limits.maxResponseBytes);
    return { kind: 'RESPONSE', status: response.statusCode, headers: flatHeaders(response.headers), body };
  } catch (error) {
    return { kind: 'UNKNOWN', phase: 'response-read', errorCode: codeOf(error) };
  }
}

async function readLimited(body: AsyncIterable<Buffer>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('RESPONSE_TOO_LARGE') as Error & { code: string };
      error.code = 'RESPONSE_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function flatHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function classify(trace: Trace, error: unknown): TransportOutcome {
  const errorCode = codeOf(error);
  if (!trace.correlated) return { kind: 'UNKNOWN', phase: 'request-write', errorCode };
  if (!trace.headersSent) return { kind: 'NOT_SENT', phase: 'connect', errorCode };
  if (trace.responseHeaders) return { kind: 'UNKNOWN', phase: 'response-read', errorCode };
  if (trace.bodySent) return { kind: 'UNKNOWN', phase: 'response-wait', errorCode };
  return { kind: 'UNKNOWN', phase: 'request-write', errorCode };
}

/** Só o código do erro: a mensagem pode citar endereço ou conteúdo e não vai para o resultado. */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (typeof cause?.code === 'string') return cause.code;
  }
  return 'UNKNOWN_ERROR';
}
