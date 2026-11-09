import type { CredentialEnvironment } from './api-key-token.js';
import type { Scope } from './scope.js';

/** Quem está chamando: a aplicação cliente autenticada por uma credencial. */
export interface Principal {
  readonly clientApplicationId: string;
  /** Id interno (uuid) da credencial usada; vai para auditoria, nunca o segredo. */
  readonly credentialRef: string;
  readonly environment: CredentialEnvironment;
  readonly scopes: ReadonlySet<Scope>;
}
