import {
  ApplicationError,
  ConflictError,
  InternalError,
  ServiceUnavailableError,
} from '../../application/errors.js';

/**
 * Tradução de erros do PostgreSQL / node-postgres / Drizzle para erros de aplicação.
 *
 * Por que é obrigatória: o `DrizzleQueryError` coloca a QUERY e os PARÂMETROS na mensagem
 * ("Failed query: ... params: ..."), e o erro do PostgreSQL traz `detail` com valores
 * ("Key (cnpj)=(...) already exists"). Nenhum dos dois pode chegar à resposta HTTP nem ao log.
 * Daqui só sai um ApplicationError com código estável e, como causa, apenas metadados seguros.
 */

/** Metadados seguros para diagnóstico (sem mensagem, detalhe, query ou parâmetros). */
export interface SafeDatabaseErrorInfo {
  readonly sqlState?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly networkCode?: string;
}

/** Mapeamento constraint → erro de negócio, declarado pelo repository que conhece a regra. */
export type ConstraintErrorMap = Readonly<Record<string, () => ApplicationError>>;

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Desce pela cadeia `cause` (Drizzle → pg) até achar o erro com SQLSTATE ou código de rede. */
function findDriverError(error: unknown): Record<string, unknown> | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    const record = asRecord(current);
    if (!record) return undefined;
    const code = record['code'];
    if (typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || NETWORK_CODES.has(code))) return record;
    current = record['cause'];
  }
  return undefined;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function safeInfo(error: unknown): SafeDatabaseErrorInfo {
  const driver = findDriverError(error);
  if (!driver) return {};
  const code = str(driver, 'code');
  const isNetwork = code !== undefined && NETWORK_CODES.has(code);
  const info: Record<string, string> = {};
  if (code !== undefined) info[isNetwork ? 'networkCode' : 'sqlState'] = code;
  for (const key of ['constraint', 'table', 'column'] as const) {
    const value = str(driver, key);
    if (value !== undefined) info[key] = value;
  }
  return info;
}

export function translateDatabaseError(error: unknown, constraints: ConstraintErrorMap = {}): ApplicationError {
  if (error instanceof ApplicationError) return error;

  const info = safeInfo(error);
  const cause = { ...info };

  if (info.networkCode !== undefined) {
    return new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'Banco de dados indisponível. Tente novamente.');
  }

  const state = info.sqlState;
  if (state === undefined) {
    // Sem SQLSTATE: pode ser erro de conexão do pool ("Connection terminated", timeout de conexão).
    const message = error instanceof Error ? error.message : '';
    if (/connection|timeout exceeded when trying to connect|terminat/i.test(message)) {
      return new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'Banco de dados indisponível. Tente novamente.');
    }
    return new InternalError('DATABASE_ERROR', { cause });
  }

  if (info.constraint !== undefined) {
    const mapped = constraints[info.constraint];
    if (mapped) return mapped();
  }

  switch (state) {
    case '23505':
      // Unique sem mapeamento = conflito não previsto pela regra de negócio → bug, não 409 genérico.
      return new InternalError('DATABASE_UNMAPPED_UNIQUE_VIOLATION', { cause });
    case '23503':
      return new InternalError('DATABASE_FOREIGN_KEY_VIOLATION', { cause });
    case '23502':
    case '23514':
      return new InternalError('DATABASE_INTEGRITY_VIOLATION', { cause });
    case '42501':
      // RLS ("new row violates row-level security policy") ou privilégio negado: sinal de segurança/bug, nunca 403 ao cliente.
      return new InternalError('DATABASE_ACCESS_VIOLATION', { cause });
    case '40001':
    case '40P01':
      return new ConflictError('CONCURRENT_UPDATE', 'O recurso foi alterado por outra operação ao mesmo tempo. Tente novamente.');
    case '57014':
      return new ServiceUnavailableError('DATABASE_TIMEOUT', 'A operação excedeu o tempo limite. Tente novamente.');
    case '53300':
    case '57P01':
    case '57P02':
    case '57P03':
      return new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'Banco de dados indisponível. Tente novamente.');
    default:
      if (state.startsWith('08')) {
        return new ServiceUnavailableError('DATABASE_UNAVAILABLE', 'Banco de dados indisponível. Tente novamente.');
      }
      if (state.startsWith('22')) return new InternalError('DATABASE_DATA_EXCEPTION', { cause });
      return new InternalError('DATABASE_ERROR', { cause });
  }
}

/** Executa uma operação de banco garantindo que só ApplicationError escape. */
export async function withDatabaseErrors<T>(operation: () => Promise<T>, constraints: ConstraintErrorMap = {}): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translateDatabaseError(error, constraints);
  }
}
