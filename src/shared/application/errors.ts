import type { ValidationIssue } from '../domain/validation-issue.js';

/**
 * Erros que a camada de aplicação pode devolver para quem a chamou (API, workers).
 *
 * Regra do projeto: nenhum erro genérico, de driver ou de ORM chega à resposta HTTP.
 * Toda falha conhecida vira uma destas classes, com `code` estável e documentado no OpenAPI;
 * o que não for conhecido vira `INTERNAL_ERROR` sem detalhes (o detalhe vai só para o log).
 */
export type ErrorCategory =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export abstract class ApplicationError extends Error {
  abstract readonly category: ErrorCategory;

  protected constructor(
    /** Código estável, em MAIÚSCULAS_COM_UNDERSCORE, exposto na API. */
    readonly code: string,
    /** Mensagem segura para o cliente (sem dados internos, sem valores sensíveis). */
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationFailedError extends ApplicationError {
  readonly category = 'VALIDATION';
  constructor(issues: readonly ValidationIssue[], message = 'Dados inválidos.') {
    super('VALIDATION_FAILED', message, issues);
  }
}

export class UnauthorizedError extends ApplicationError {
  readonly category = 'UNAUTHORIZED';
  constructor(code = 'UNAUTHORIZED', message = 'Credencial ausente ou inválida.') {
    super(code, message);
  }
}

export class ForbiddenError extends ApplicationError {
  readonly category = 'FORBIDDEN';
  constructor(code = 'FORBIDDEN', message = 'Operação não permitida para esta credencial.') {
    super(code, message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly category = 'NOT_FOUND';
  constructor(code = 'NOT_FOUND', message = 'Recurso não encontrado.') {
    super(code, message);
  }
}

export class ConflictError extends ApplicationError {
  readonly category = 'CONFLICT';
  // Necessário: torna público o construtor protegido da base, exigindo code e message.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Regra de negócio/fiscal violada com dados sintaticamente válidos. */
export class BusinessRuleError extends ApplicationError {
  readonly category = 'UNPROCESSABLE';
  constructor(code: string, message: string, issues: readonly ValidationIssue[] = []) {
    super(code, message, issues);
  }
}

/** Dependência indisponível (banco, storage...). O cliente pode tentar de novo depois. */
export class ServiceUnavailableError extends ApplicationError {
  readonly category = 'UNAVAILABLE';
  constructor(
    code = 'SERVICE_UNAVAILABLE',
    message = 'Serviço temporariamente indisponível. Tente novamente.',
    readonly retryAfterSeconds = 5,
  ) {
    super(code, message);
  }
}

/** Falha interna conhecida. A resposta sai como INTERNAL_ERROR genérico; `code` fica no log. */
export class InternalError extends ApplicationError {
  readonly category = 'INTERNAL';
  constructor(code: string, options?: { cause?: unknown }) {
    super(code, 'Erro interno.');
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
