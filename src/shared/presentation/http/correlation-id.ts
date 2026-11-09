import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Aceita apenas identificadores seguros vindos do cliente; caso contrário, gera um novo. */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function correlationIdFrom(request: IncomingMessage): string {
  const header = request.headers[CORRELATION_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && SAFE_ID.test(candidate) ? candidate : randomUUID();
}
