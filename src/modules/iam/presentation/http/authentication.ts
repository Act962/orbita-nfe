import { ValidationFailedError } from '../../../../shared/application/errors.js';
import type { HttpApp } from '../../../../shared/presentation/http/http-app.js';
import { COMPANY_HEADER } from '../../../../shared/presentation/http/request-context.js';
import type { AccessControl } from '../../application/access-control.js';
import { isScope } from '../../domain/scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function companyFromHeader(value: string | string[] | undefined): string {
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  throw new ValidationFailedError([
    {
      code: value === undefined ? 'REQUIRED' : 'INVALID_FORMAT',
      field: `headers.${COMPANY_HEADER}`,
      message: 'Informe o header X-Company-Id com o UUID da empresa.',
    },
  ]);
}

/**
 * Autenticação e autorização de toda rota com `config.auth` (docs/architecture/14 §B1).
 *
 * Roda em `onRequest`, antes de ler o corpo: quem não está autenticado não recebe nem
 * detalhes de validação. A empresa vem do header e é confirmado pela concessão no servidor;
 * nada no corpo (CNPJ, ids) define a empresa.
 *
 * Deve ser registrada antes das rotas.
 */
export function registerAuthentication(app: HttpApp, accessControl: AccessControl): void {
  app.decorateRequest('caller', null);

  // Escopo inexistente numa rota = erro de programação: impede a inicialização.
  app.addHook('onRoute', (route) => {
    const auth = route.config?.auth;
    if (auth !== undefined && !('public' in auth) && !isScope(auth.scope)) {
      throw new Error(`Rota ${String(route.method)} ${route.url} exige escopo fora do catálogo: ${auth.scope}`);
    }
  });

  app.addHook('onRequest', async (request) => {
    const auth = request.routeOptions.config.auth;
    if (auth === undefined || 'public' in auth || !isScope(auth.scope)) return;

    const principal = await accessControl.authenticate(request.headers.authorization);
    accessControl.requireScope(principal, auth.scope);

    let companyId: string | undefined;
    if (auth.company) {
      companyId = companyFromHeader(request.headers[COMPANY_HEADER]);
      await accessControl.requireCompanyAccess(principal, companyId);
    }

    request.caller = {
      clientApplicationId: principal.clientApplicationId,
      credentialRef: principal.credentialRef,
      environment: principal.environment,
      ...(companyId !== undefined ? { companyId } : {}),
    };
    request.log = request.log.child({
      clientApplicationId: principal.clientApplicationId,
      ...(companyId !== undefined ? { companyId } : {}),
    });
  });
}
