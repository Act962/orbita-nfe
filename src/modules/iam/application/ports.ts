import type { AuditContext, AuditRecord, PlatformAuditAction } from '../../../shared/application/audit.js';
import type { CredentialEnvironment } from '../domain/api-key-token.js';

/** Credencial ativa, como lida para autenticação. Nunca contém o segredo, só o HMAC. */
export interface ActiveCredential {
  readonly id: string;
  readonly clientApplicationId: string;
  readonly environment: CredentialEnvironment;
  readonly secretHash: Uint8Array;
  readonly scopes: readonly string[];
}

export interface CredentialLookup {
  /** Credencial ATIVA, não expirada, de aplicação ATIVA. `undefined` em qualquer outro caso. */
  findActiveByKeyId(keyId: string): Promise<ActiveCredential | undefined>;
}

/** HMAC-SHA256 com pepper guardado fora do banco (ADR-0012). */
export interface SecretHasher {
  hash(secret: string): Uint8Array;
  /** Comparação em tempo constante. */
  matches(secret: string, expectedHash: Uint8Array): boolean;
}

export type CompanyAccess = 'GRANTED' | 'NO_GRANT' | 'COMPANY_SUSPENDED';

export interface CompanyAccessLookup {
  /** Lido no contexto da empresa (RLS) e sem cache: revogação vale na requisição seguinte. */
  accessOf(clientApplicationId: string, companyId: string): Promise<CompanyAccess>;
}

/** Material aleatório de uma nova credencial (CSPRNG na infraestrutura). */
export interface KeyMaterialSource {
  keyId(): string;
  secret(): string;
}

export interface NewCredential {
  readonly id: string;
  readonly clientApplicationId: string;
  readonly keyId: string;
  readonly secretHash: Uint8Array;
  readonly environment: CredentialEnvironment;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | undefined;
}

/** Registro de auditoria gravado na MESMA transação da operação (só se ela tiver efeito). */
export interface PlatformAuditWrite {
  readonly context: AuditContext;
  readonly record: AuditRecord<PlatformAuditAction>;
}
export interface CompanyAuditWrite {
  readonly context: AuditContext;
  readonly record: AuditRecord;
}

/** Operações administrativas (CLI de operador, papel de banco fiscal_admin). Toda escrita é auditada. */
export interface IamAdminStore {
  createClientApplication(id: string, name: string, audit: PlatformAuditWrite): Promise<void>;
  clientApplicationExists(id: string): Promise<boolean>;
  insertCredential(credential: NewCredential, audit: PlatformAuditWrite): Promise<void>;
  /** `false` se não havia credencial ativa com esse keyId (nada é auditado). */
  revokeCredential(keyId: string, audit: PlatformAuditWrite): Promise<boolean>;
  /** Cria ou reativa a concessão. `false` se a empresa não existe. */
  grantCompany(clientApplicationId: string, companyId: string, audit: CompanyAuditWrite): Promise<boolean>;
  /** `false` se não havia concessão ativa. */
  revokeCompanyGrant(clientApplicationId: string, companyId: string, audit: CompanyAuditWrite): Promise<boolean>;
}

/** Usada dentro da transação de criação de empresa (módulo company). */
export interface CompanyGrantWriter {
  grant(companyId: string, clientApplicationId: string): Promise<void>;
}
