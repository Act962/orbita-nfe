import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { ApplicationError, RateLimitedError, ServiceUnavailableError, type ErrorCategory } from '../../application/errors.js';
import type { HttpApp } from './http-app.js';
import { PROBLEM_CONTENT_TYPE, problemType, type Problem, type ProblemIssue } from './problem.js';

const STATUS: Record<ErrorCategory, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const TITLE: Record<ErrorCategory, string> = {
  VALIDATION: 'Requisição inválida',
  UNAUTHORIZED: 'Não autenticado',
  FORBIDDEN: 'Acesso negado',
  NOT_FOUND: 'Recurso não encontrado',
  CONFLICT: 'Conflito',
  UNPROCESSABLE: 'Regra de negócio violada',
  RATE_LIMITED: 'Limite de requisições excedido',
  UNAVAILABLE: 'Serviço indisponível',
  INTERNAL: 'Erro interno',
};

/**
 * Erros de protocolo do Fastify que podem chegar ao cliente, com código próprio.
 * Qualquer outro código do Fastify vira BAD_REQUEST genérico (nunca a mensagem interna).
 */
const FASTIFY_CLIENT_ERRORS: Record<string, { status: number; code: string; title: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'MALFORMED_BODY', title: 'Corpo da requisição malformado' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'MALFORMED_BODY', title: 'Corpo da requisição vazio' },
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'PAYLOAD_TOO_LARGE', title: 'Corpo da requisição grande demais' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Content-Type não suportado' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'MALFORMED_BODY', title: 'Content-Length inválido' },
};

function send(request: FastifyRequest, reply: FastifyReply, problem: Omit<Problem, 'type' | 'instance' | 'correlationId'>): FastifyReply {
  const body: Problem = {
    type: problemType(problem.code),
    ...problem,
    instance: request.url.split('?')[0] ?? request.url,
    correlationId: request.id,
  };
  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/** Converte o código de issue do Zod (ex.: invalid_type) em código estável (INVALID_TYPE). */
function issueCode(keyword: string): string {
  return keyword.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
}

/**
 * Tratamento global de erros. Ordem:
 * 1. Validação de entrada (Fastify + Zod) → 400 VALIDATION_FAILED com cada campo.
 * 2. ApplicationError → status pela categoria, com `code` estável.
 * 3. Erros de protocolo conhecidos do Fastify → código próprio.
 * 4. Qualquer outra coisa (inclusive erros de banco/ORM não traduzidos e resposta que não
 *    bate com o schema) → 500 INTERNAL_ERROR, sem detalhes. O detalhe vai só para o log.
 */
export function registerErrorHandling(app: HttpApp): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const context = error.validationContext ?? 'body';
      const issues: ProblemIssue[] = error.validation.map((v) => ({
        code: issueCode(v.keyword),
        message: v.message ?? 'Valor inválido.',
        field: v.instancePath === '/' ? context : `${context}${v.instancePath.replaceAll('/', '.')}`,
      }));
      return send(request, reply, { status: 400, code: 'VALIDATION_FAILED', title: TITLE.VALIDATION, issues });
    }

    if (error instanceof ApplicationError) {
      const status = STATUS[error.category];
      if (error.category === 'INTERNAL') {
        request.log.error({ err: error, errorCode: error.code }, 'erro interno conhecido');
        return send(request, reply, { status, code: 'INTERNAL_ERROR', title: TITLE.INTERNAL });
      }
      if (error.category === 'UNAUTHORIZED') void reply.header('www-authenticate', 'Bearer');
      if (error instanceof RateLimitedError) void reply.header('retry-after', String(error.retryAfterSeconds));
      if (error instanceof ServiceUnavailableError) {
        request.log.warn({ err: error, errorCode: error.code }, 'dependência indisponível');
        void reply.header('retry-after', String(error.retryAfterSeconds));
      }
      return send(request, reply, {
        status,
        code: error.code,
        title: TITLE[error.category],
        detail: error.message,
        ...(error.issues.length > 0 ? { issues: error.issues.map((i) => ({ ...i })) } : {}),
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'resposta não corresponde ao schema declarado');
      return send(request, reply, { status: 500, code: 'INTERNAL_ERROR', title: TITLE.INTERNAL });
    }

    const known = typeof error.code === 'string' ? FASTIFY_CLIENT_ERRORS[error.code] : undefined;
    if (known) {
      request.log.info({ errorCode: error.code }, 'requisição rejeitada');
      return send(request, reply, known);
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.info({ err: error }, 'requisição rejeitada');
      return send(request, reply, { status: error.statusCode, code: 'BAD_REQUEST', title: 'Requisição rejeitada' });
    }

    request.log.error({ err: error }, 'erro inesperado');
    return send(request, reply, { status: 500, code: 'INTERNAL_ERROR', title: TITLE.INTERNAL });
  });

  app.setNotFoundHandler((request, reply) =>
    send(request, reply, { status: 404, code: 'ROUTE_NOT_FOUND', title: TITLE.NOT_FOUND }),
  );
}
