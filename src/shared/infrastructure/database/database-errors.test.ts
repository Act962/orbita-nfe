import { describe, expect, it } from 'vitest';
import { ConflictError, InternalError, ServiceUnavailableError } from '../../application/errors.js';
import { safeInfo, translateDatabaseError, withDatabaseErrors } from './database-errors.js';

/** Reproduz o formato real: DrizzleQueryError com a query e os parâmetros na mensagem e o erro do pg em `cause`. */
function drizzleError(pgFields: Record<string, string>): Error {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), {
    detail: 'Key (cnpj)=(SEGREDO-11222333000181) already exists.',
    ...pgFields,
  });
  return Object.assign(new Error('Failed query: insert into "x" values ($1)\nparams: SEGREDO-11222333000181'), { cause: pgError });
}

describe('translateDatabaseError', () => {
  it('usa o mapeamento de constraint declarado pelo repository', () => {
    const error = translateDatabaseError(drizzleError({ code: '23505', constraint: 'uq_establishments_cnpj' }), {
      uq_establishments_cnpj: () => new ConflictError('ESTABLISHMENT_ALREADY_REGISTERED', 'Estabelecimento já cadastrado.'),
    });
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('ESTABLISHMENT_ALREADY_REGISTERED');
  });

  it.each([
    [{ code: '23505', constraint: 'uq_nao_mapeada' }, InternalError, 'DATABASE_UNMAPPED_UNIQUE_VIOLATION'],
    [{ code: '23503', constraint: 'fk_x' }, InternalError, 'DATABASE_FOREIGN_KEY_VIOLATION'],
    [{ code: '23514' }, InternalError, 'DATABASE_INTEGRITY_VIOLATION'],
    [{ code: '42501', table: 'establishments' }, InternalError, 'DATABASE_ACCESS_VIOLATION'],
    [{ code: '40001' }, ConflictError, 'CONCURRENT_UPDATE'],
    [{ code: '40P01' }, ConflictError, 'CONCURRENT_UPDATE'],
    [{ code: '57014' }, ServiceUnavailableError, 'DATABASE_TIMEOUT'],
    [{ code: '08006' }, ServiceUnavailableError, 'DATABASE_UNAVAILABLE'],
    [{ code: '53300' }, ServiceUnavailableError, 'DATABASE_UNAVAILABLE'],
    [{ code: '22P02' }, InternalError, 'DATABASE_DATA_EXCEPTION'],
    [{ code: 'XX000' }, InternalError, 'DATABASE_ERROR'],
  ])('%o → %s %s', (fields, type, code) => {
    const error = translateDatabaseError(drizzleError(fields));
    expect(error).toBeInstanceOf(type);
    expect(error.code).toBe(code);
  });

  it('erros de rede e de conexão do pool → DATABASE_UNAVAILABLE', () => {
    expect(translateDatabaseError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })).code).toBe('DATABASE_UNAVAILABLE');
    expect(translateDatabaseError(new Error('Connection terminated unexpectedly')).code).toBe('DATABASE_UNAVAILABLE');
    expect(translateDatabaseError(new Error('timeout exceeded when trying to connect')).code).toBe('DATABASE_UNAVAILABLE');
  });

  it('nunca carrega mensagem, detalhe, query ou parâmetros do driver', () => {
    const error = translateDatabaseError(drizzleError({ code: '23505', constraint: 'uq_nao_mapeada', table: 'establishments' }));
    const serialized = JSON.stringify({ message: error.message, cause: error.cause, issues: error.issues });
    expect(serialized).not.toContain('SEGREDO');
    expect(serialized).not.toContain('Failed query');
    expect(error.cause).toEqual({ sqlState: '23505', constraint: 'uq_nao_mapeada', table: 'establishments' });
  });

  it('ApplicationError passa direto; erro desconhecido vira DATABASE_ERROR', () => {
    const conflict = new ConflictError('X', 'y');
    expect(translateDatabaseError(conflict)).toBe(conflict);
    expect(translateDatabaseError('string solta').code).toBe('DATABASE_ERROR');
    expect(safeInfo(null)).toEqual({});
  });

  it('withDatabaseErrors só deixa escapar ApplicationError', async () => {
    await expect(withDatabaseErrors(() => Promise.reject(drizzleError({ code: '57014' })))).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(withDatabaseErrors(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
