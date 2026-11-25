import { Cnpj } from '../../../shared/domain/cnpj.js';
import { err, ok, type Result } from '../../../shared/domain/result.js';
import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';

/**
 * Contribuinte (empresa) e estabelecimentos (docs/architecture/02 §2).
 *
 * Uma empresa é identificada pela RAIZ do CNPJ (8 primeiras posições, CNPJ-001): matriz e
 * filiais compartilham a raiz, e cada documento fiscal é emitido por um estabelecimento.
 * Regra COMPANY-001: o CNPJ de um estabelecimento tem a mesma raiz da sua empresa.
 */
export type CompanyStatus = 'ACTIVE' | 'SUSPENDED';
export type EstablishmentStatus = 'ACTIVE' | 'INACTIVE';

export interface Company {
  readonly id: string;
  readonly legalName: string;
  readonly rootCnpj: string;
  readonly status: CompanyStatus;
  readonly createdAt: Date;
}

export interface Establishment {
  readonly id: string;
  readonly companyId: string;
  readonly cnpj: string;
  readonly tradeName: string;
  /** Código IBGE do município (7 dígitos). */
  readonly municipalityCode: string;
  /**
   * Inscrição municipal (IM), só cadastro (ADR-0061): o motor guarda e devolve, mas NÃO a coloca na
   * DPS. A IM da nota continua sendo a que o cliente envia em `provider.municipalRegistration`.
   */
  readonly municipalRegistration: string | null;
  readonly status: EstablishmentStatus;
  readonly createdAt: Date;
}

export type NewCompany = Omit<Company, 'createdAt'>;
export type NewEstablishment = Omit<Establishment, 'createdAt'>;

const NAME_MAX = 150;
const ROOT_CNPJ = /^[0-9A-Z]{8}$/;
const IBGE_MUNICIPALITY = /^[0-9]{7}$/;
/** TSInscMun (XSD da NFS-e nacional, os dois pacotes): de 1 a 15 caracteres. */
const MUNICIPAL_REGISTRATION_MAX = 15;

/** IM sem espaços nas pontas, de 1 a 15 caracteres (TSInscMun); nula apaga. */
export function municipalRegistration(value: string | null | undefined, issues: ValidationIssue[]): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MUNICIPAL_REGISTRATION_MAX) {
    issues.push({ code: 'INVALID_LENGTH', field: 'municipalRegistration', message: `A inscrição municipal tem de 1 a ${MUNICIPAL_REGISTRATION_MAX} caracteres (TSInscMun).` });
  }
  return trimmed;
}

function name(field: string, value: string, issues: ValidationIssue[]): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    issues.push({ code: 'INVALID_LENGTH', field, message: `Deve ter de 1 a ${NAME_MAX} caracteres.` });
  }
  return trimmed;
}

export function newCompany(input: { id: string; legalName: string; rootCnpj: string }): Result<NewCompany, ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const legalName = name('legalName', input.legalName, issues);
  const rootCnpj = input.rootCnpj.replace(/[.\s]/g, '').toUpperCase();
  if (!ROOT_CNPJ.test(rootCnpj)) {
    issues.push({ code: 'CNPJ_INVALID_ROOT', field: 'rootCnpj', message: 'A raiz do CNPJ tem 8 caracteres alfanuméricos.', ruleId: 'CNPJ-001' });
  }
  if (issues.length > 0) return err(issues);
  return ok({ id: input.id, legalName, rootCnpj, status: 'ACTIVE' });
}

export type EstablishmentError = { kind: 'INVALID'; issues: ValidationIssue[] } | { kind: 'ROOT_MISMATCH'; issue: ValidationIssue };

export function newEstablishment(
  company: Pick<Company, 'id' | 'rootCnpj'>,
  input: { id: string; cnpj: string; tradeName: string; municipalityCode: string; municipalRegistration?: string | null | undefined },
): Result<NewEstablishment, EstablishmentError> {
  const issues: ValidationIssue[] = [];
  const cnpj = Cnpj.parse(input.cnpj);
  if (!cnpj.ok) issues.push({ ...cnpj.error, field: 'cnpj' });
  const tradeName = name('tradeName', input.tradeName, issues);
  if (!IBGE_MUNICIPALITY.test(input.municipalityCode)) {
    issues.push({ code: 'INVALID_MUNICIPALITY_CODE', field: 'municipalityCode', message: 'Código IBGE do município tem 7 dígitos.' });
  }
  const registration = municipalRegistration(input.municipalRegistration, issues);
  if (!cnpj.ok || issues.length > 0) return err({ kind: 'INVALID', issues });

  if (cnpj.value.root !== company.rootCnpj) {
    return err({
      kind: 'ROOT_MISMATCH',
      issue: {
        code: 'ESTABLISHMENT_ROOT_MISMATCH',
        field: 'cnpj',
        message: 'A raiz do CNPJ do estabelecimento é diferente da raiz do CNPJ da empresa.',
        ruleId: 'COMPANY-001',
      },
    });
  }
  return ok({
    id: input.id,
    companyId: company.id,
    cnpj: cnpj.value.value,
    tradeName,
    municipalityCode: input.municipalityCode,
    municipalRegistration: registration,
    status: 'ACTIVE',
  });
}
