import type { AuditContext } from '../../../shared/application/audit.js';
import { NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator } from '../../../shared/application/unit-of-work.js';
import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';
import { formatApiKeyToken, type CredentialEnvironment } from '../domain/api-key-token.js';
import { isScope } from '../domain/scope.js';
import type { IamAdminStore, KeyMaterialSource, SecretHasher } from './ports.js';

export interface IssueCredentialInput {
  readonly clientApplicationId: string;
  readonly environment: CredentialEnvironment;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
}

export interface IssuedCredential {
  readonly id: string;
  readonly keyId: string;
  /** Exibido UMA vez para o operador. Nunca registrado em log nem persistido. */
  readonly token: string;
}

const MAX_NAME = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(field: string, value: string): void {
  if (!UUID.test(value)) throw new ValidationFailedError([{ code: 'INVALID_UUID', field, message: 'Informe um UUID.' }]);
}

/**
 * Casos de uso do operador (CLI). Toda escrita é auditada na mesma transação: aplicações e
 * credenciais na cadeia da plataforma; concessões na cadeia da empresa.
 */
export class IamAdmin {
  constructor(
    private readonly store: IamAdminStore,
    private readonly hasher: SecretHasher,
    private readonly keyMaterial: KeyMaterialSource,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createClientApplication(name: string, context: AuditContext): Promise<string> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME) {
      throw new ValidationFailedError([{ code: 'INVALID_NAME', field: 'name', message: `Nome deve ter de 1 a ${MAX_NAME} caracteres.` }]);
    }
    const id = this.newId();
    await this.store.createClientApplication(id, trimmed, {
      context,
      record: { action: 'client_application.created', subject: { type: 'client_application', id }, details: { name: trimmed } },
    });
    return id;
  }

  async issueCredential(input: IssueCredentialInput, context: AuditContext): Promise<IssuedCredential> {
    requireUuid('clientApplicationId', input.clientApplicationId);
    const issues: ValidationIssue[] = [];
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0) issues.push({ code: 'SCOPES_REQUIRED', field: 'scopes', message: 'Informe ao menos um escopo.' });
    for (const scope of scopes) {
      if (!isScope(scope)) issues.push({ code: 'UNKNOWN_SCOPE', field: 'scopes', message: `Escopo desconhecido: ${scope}.` });
    }
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= this.now().getTime()) {
      issues.push({ code: 'EXPIRATION_IN_PAST', field: 'expiresAt', message: 'A expiração deve ser futura.' });
    }
    if (issues.length > 0) throw new ValidationFailedError(issues);

    if (!(await this.store.clientApplicationExists(input.clientApplicationId))) {
      throw new NotFoundError('CLIENT_APPLICATION_NOT_FOUND', 'Aplicação cliente não encontrada.');
    }

    const keyId = this.keyMaterial.keyId();
    const secret = this.keyMaterial.secret();
    const token = formatApiKeyToken({ environment: input.environment, keyId, secret });
    const id = this.newId();
    await this.store.insertCredential({
      id,
      clientApplicationId: input.clientApplicationId,
      keyId,
      secretHash: this.hasher.hash(secret),
      environment: input.environment,
      scopes,
      expiresAt: input.expiresAt,
    }, {
      context,
      record: {
        action: 'credential.issued',
        subject: { type: 'credential', id },
        details: {
          clientApplicationId: input.clientApplicationId,
          keyId,
          environment: input.environment,
          scopes,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        },
      },
    });
    return { id, keyId, token };
  }

  async revokeCredential(keyId: string, context: AuditContext): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(keyId)) throw new ValidationFailedError([{ code: 'INVALID_KEY_ID', field: 'keyId', message: 'keyId tem 16 hexadecimais.' }]);
    const audit = { context, record: { action: 'credential.revoked', subject: { type: 'credential_key', id: keyId } } } as const;
    if (!(await this.store.revokeCredential(keyId, audit))) {
      throw new NotFoundError('CREDENTIAL_NOT_FOUND', 'Credencial ativa não encontrada.');
    }
  }

  async grantCompany(clientApplicationId: string, companyId: string, context: AuditContext): Promise<void> {
    requireUuid('clientApplicationId', clientApplicationId);
    requireUuid('companyId', companyId);
    if (!(await this.store.clientApplicationExists(clientApplicationId))) {
      throw new NotFoundError('CLIENT_APPLICATION_NOT_FOUND', 'Aplicação cliente não encontrada.');
    }
    const audit = { context, record: { action: 'company_grant.granted', subject: { type: 'client_application', id: clientApplicationId } } } as const;
    if (!(await this.store.grantCompany(clientApplicationId, companyId, audit))) {
      throw new NotFoundError('COMPANY_NOT_FOUND', 'Empresa não encontrada.');
    }
  }

  async revokeCompanyGrant(clientApplicationId: string, companyId: string, context: AuditContext): Promise<void> {
    requireUuid('clientApplicationId', clientApplicationId);
    requireUuid('companyId', companyId);
    const audit = { context, record: { action: 'company_grant.revoked', subject: { type: 'client_application', id: clientApplicationId } } } as const;
    if (!(await this.store.revokeCompanyGrant(clientApplicationId, companyId, audit))) {
      throw new NotFoundError('COMPANY_GRANT_NOT_FOUND', 'Concessão ativa não encontrada.');
    }
  }
}
