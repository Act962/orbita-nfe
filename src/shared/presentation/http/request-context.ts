import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditContext } from '../../application/audit.js';
import { InternalError } from '../../application/errors.js';
import { ProblemSchema } from './problem.js';

/**
 * Autorização declarada em cada rota (`config.auth`). Toda rota sob /v1 é obrigada a declarar
 * (route-catalog.ts recusa a inicialização se faltar): o padrão é fechado.
 *
 * - `{ public: true }`: sem credencial (só fora de /v1);
 * - `{ scope, company: false }`: credencial com o escopo, sem empresa (ex.: criar empresa);
 * - `{ scope, company: true }`: credencial com o escopo + concessão para a empresa do header
 *   `X-Company-Id`, validada no servidor (nunca pelo CNPJ ou id enviado no corpo).
 */
export type RouteAuth = { readonly public: true } | { readonly scope: string; readonly company: boolean };

/** Quem chama, já autenticado e autorizado pelo módulo IAM. */
export interface CallerContext {
  readonly clientApplicationId: string;
  readonly credentialRef: string;
  readonly environment: 'live' | 'test';
  /** Presente apenas em rotas `company: true`, depois de conferida a concessão. */
  readonly companyId?: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    caller: CallerContext | null;
  }
}

export const COMPANY_HEADER = 'x-company-id';

/** Schema do header de empresa, para validação e documentação (Scalar). */
export const CompanyHeaders = z.object({
  [COMPANY_HEADER]: z.uuid().meta({
    description: 'Empresa em nome da qual a operação é feita. A credencial precisa ter concessão para ela.',
    example: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20',
  }),
});

export const authErrorResponses = {
  401: ProblemSchema.describe('Credencial ausente, inválida, revogada ou expirada (UNAUTHORIZED).'),
  403: ProblemSchema.describe(
    'Sem o escopo exigido (INSUFFICIENT_SCOPE), sem concessão para a empresa (COMPANY_ACCESS_DENIED) ou empresa suspensa (COMPANY_SUSPENDED).',
  ),
} as const;

export function callerOf(request: FastifyRequest): CallerContext {
  if (request.caller === null) throw new InternalError('ROUTE_WITHOUT_AUTH_CONTEXT');
  return request.caller;
}

export function companyIdOf(request: FastifyRequest): string {
  const companyId = callerOf(request).companyId;
  if (companyId === undefined) throw new InternalError('ROUTE_WITHOUT_COMPANY_CONTEXT');
  return companyId;
}

/** Ator e correlation id da requisição, para a trilha de auditoria. */
export function auditContextOf(request: FastifyRequest): AuditContext {
  const caller = callerOf(request);
  return {
    actor: { kind: 'CLIENT_APPLICATION', clientApplicationId: caller.clientApplicationId, credentialRef: caller.credentialRef },
    correlationId: request.id,
  };
}
