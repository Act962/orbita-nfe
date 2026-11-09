/**
 * Resultado explícito para operações de domínio que podem falhar por regra de negócio.
 * Exceções ficam reservadas para falhas inesperadas (bugs, infraestrutura).
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });
