/**
 * Fachada pública do módulo IAM. Outros módulos e o composition root só importam daqui.
 */
export { AccessControl } from './application/access-control.js';
export { IamAdmin, type IssueCredentialInput, type IssuedCredential } from './application/iam-admin.js';
export type { CompanyGrantWriter } from './application/ports.js';
export { SCOPES, isScope, type Scope } from './domain/scope.js';
export type { CredentialEnvironment } from './domain/api-key-token.js';
export { HmacSecretHasher, RandomKeyMaterial, loadPepperFile } from './infrastructure/crypto/api-key-crypto.js';
export {
  DrizzleCredentialLookup,
  DrizzleIamAdminStore,
  DrizzleCompanyAccessLookup,
  companyGrantWriter,
} from './infrastructure/persistence/repositories.js';
export { registerAuthentication } from './presentation/http/authentication.js';
