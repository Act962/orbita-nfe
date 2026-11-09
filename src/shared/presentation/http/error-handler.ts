import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpApp } from './http-app.js';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { HttpProblemError, PROBLEM_CONTENT_TYPE, problemType, type Problem, type ProblemIssue } from './problem.js';

function send(request: FastifyRequest, reply: FastifyReply, problem: Omit<Problem, 'type' | 'instance' | 'correlationId'>): FastifyReply {
  const body: Problem = {
    type: problemType(problem.code),
    ...problem,
    instance: request.url.split('?')[0] ?? request.url,
    correlationId: request.id,
  };
  return reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/**
 * Tratamento global de erros. Erros inesperados viram 500 genérico: a mensagem interna
 * vai só para o log (sanitizado), nunca para o cliente.
 */
export function registerErrorHandling(app: HttpApp): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues: ProblemIssue[] = error.validation.map((v) => ({
        code: 'INVALID_FIELD',
        message: v.message ?? 'Valor inválido',
        field: `${error.validationContext ?? 'body'}${v.instancePath.replaceAll('/', '.')}`,
      }));
      return send(request, reply, { status: 400, code: 'VALIDATION_FAILED', title: 'Requisição inválida', issues });
    }

    if (error instanceof HttpProblemError) {
      return send(request, reply, {
        status: error.status,
        code: error.code,
        title: error.title,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.issues === undefined ? {} : { issues: error.issues }),
      });
    }

    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status < 500) {
      // Erros de protocolo do Fastify (JSON malformado, corpo grande demais, content-type...).
      request.log.info({ err: error }, 'requisição rejeitada');
      return send(request, reply, { status, code: error.code || 'BAD_REQUEST', title: 'Requisição rejeitada' });
    }

    request.log.error({ err: error }, 'erro inesperado');
    return send(request, reply, { status: 500, code: 'INTERNAL_ERROR', title: 'Erro interno' });
  });

  app.setNotFoundHandler((request, reply) =>
    send(request, reply, { status: 404, code: 'NOT_FOUND', title: 'Recurso não encontrado' }),
  );
}
