import { ForbiddenError, UnauthorizedError } from '../../../shared/application/errors.js';
import { parseApiKeyToken } from '../domain/api-key-token.js';
import type { Principal } from '../domain/principal.js';
import { isScope, scopeSatisfies, type Scope } from '../domain/scope.js';
import type { CredentialLookup, SecretHasher, CompanyAccessLookup } from './ports.js';

/** Hash fixo usado quando a credencial não existe: o tempo de resposta não revela se o keyId existe. */
const DUMMY_HASH = new Uint8Array(32);

/** Mesma resposta para qualquer falha de autenticação: não ajuda a enumerar credenciais. */
const unauthorized = (): UnauthorizedError => new UnauthorizedError();

/**
 * Autenticação e autorização das chamadas (ADR-0012, docs/architecture/09 §1 e 14 §B3).
 * Ordem: credencial (401) → escopo (403) → concessão para a empresa (403).
 */
export class AccessControl {
  constructor(
    private readonly credentials: CredentialLookup,
    private readonly hasher: SecretHasher,
    private readonly companyAccess: CompanyAccessLookup,
  ) {}

  /** `authorization`: valor do header HTTP. Somente `Bearer <api key>`. */
  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (authorization === undefined) throw unauthorized();
    const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
    if (!match?.[1]) throw unauthorized();

    const token = parseApiKeyToken(match[1]);
    if (!token.ok) throw unauthorized();

    const credential = await this.credentials.findActiveByKeyId(token.value.keyId);
    if (credential === undefined) {
      this.hasher.matches(token.value.secret, DUMMY_HASH);
      throw unauthorized();
    }
    if (!this.hasher.matches(token.value.secret, credential.secretHash)) throw unauthorized();
    // O ambiente faz parte do token: uma chave de teste não vira chave de produção trocando o prefixo.
    if (credential.environment !== token.value.environment) throw unauthorized();

    return {
      clientApplicationId: credential.clientApplicationId,
      credentialRef: credential.id,
      environment: credential.environment,
      // Escopo desconhecido gravado no banco é ignorado (nunca amplia acesso).
      scopes: new Set(credential.scopes.filter(isScope)),
    };
  }

  requireScope(principal: Principal, scope: Scope): void {
    if (!scopeSatisfies(principal.scopes, scope)) {
      throw new ForbiddenError('INSUFFICIENT_SCOPE', `A credencial não tem o escopo exigido por esta operação (${scope}).`);
    }
  }

  async requireCompanyAccess(principal: Principal, companyId: string): Promise<void> {
    const access = await this.companyAccess.accessOf(principal.clientApplicationId, companyId);
    if (access === 'NO_GRANT') {
      throw new ForbiddenError('COMPANY_ACCESS_DENIED', 'A credencial não tem concessão para operar esta empresa.');
    }
    if (access === 'COMPANY_SUSPENDED') {
      throw new ForbiddenError('COMPANY_SUSPENDED', 'A empresa está suspensa.');
    }
  }
}
