import { KeyObject } from 'node:crypto';

/**
 * Sanitização profunda de tudo o que vai para o log (docs/architecture/13 §7).
 *
 * - Chaves sensíveis em qualquer profundidade → "[REDACTED]".
 * - Buffer / TypedArray / KeyObject → "[REDACTED:<tipo>]" (nunca logar bytes brutos:
 *   podem ser PFX, chave privada ou XML com dados pessoais).
 * - Erros: mantém nome, mensagem, código e stack; `cause` também é sanitizada.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /pass(word|phrase|wd)?|senha|secret|token|authorization|cookie|pfx|p12|pkcs12|private.?key|chave.?privada|\bcsc\b|^csc|api.?key|kek|dek|credential/i;

const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? '[Function]' : value;
  }
  if (Buffer.isBuffer(value)) return '[REDACTED:Buffer]';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[REDACTED:Binary]';
  if (value instanceof KeyObject) return '[REDACTED:KeyObject]';
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: value.message, stack: value.stack };
    const code = (value as { code?: unknown }).code;
    if (code !== undefined) out['code'] = code;
    if (value.cause !== undefined) out['cause'] = sanitize(value.cause, depth + 1, seen);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
  }
  return out;
}
