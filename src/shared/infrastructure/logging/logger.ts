import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';
import { sanitize } from './sanitize.js';

export type { Logger } from 'pino';

export interface LoggerOptions {
  readonly level: LevelWithSilent;
  readonly service: string;
  /** Destino alternativo (testes). Padrão: stdout. */
  readonly destination?: DestinationStream;
}

/**
 * Logger JSON único da aplicação. Toda saída passa por `sanitize` (objeto de log, bindings
 * e erros), além do `redact` do pino para cabeçalhos HTTP conhecidos.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'message',
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => sanitize(bindings) as Record<string, unknown>,
        log: (object) => sanitize(object) as Record<string, unknown>,
      },
      serializers: {
        err: (error: unknown) => sanitize(error),
        error: (error: unknown) => sanitize(error),
      },
      hooks: {
        // Última barreira: o pino não aplica `formatters.bindings` aos bindings de loggers
        // filhos (`child({...})`), então cada linha é sanitizada de novo antes da escrita.
        // Descoberto pelo teste canário.
        streamWrite: sanitizeLine,
      },
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'req.body', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
    },
    options.destination,
  );
}

function sanitizeLine(line: string): string {
  try {
    const trailingNewline = line.endsWith('\n');
    const sanitized = JSON.stringify(sanitize(JSON.parse(line)));
    return trailingNewline ? `${sanitized}\n` : sanitized;
  } catch {
    // Linha que não é JSON válido não deveria existir; descarta o conteúdo em vez de arriscar.
    return `${JSON.stringify({ level: 'error', message: '[linha de log descartada: formato inválido]' })}\n`;
  }
}
