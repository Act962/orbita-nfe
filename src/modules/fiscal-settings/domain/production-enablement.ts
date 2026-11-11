import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';
import type { DocumentKind } from './document-series.js';

/**
 * Habilitação de produção por estabelecimento e modalidade (ADR-0027 item 1; docs/architecture/14 §L5).
 *
 * Duas travas independentes precisam concordar para um documento ir à produção:
 * 1. a credencial é `live` (o ambiente vem da credencial, ADR-0026 item 3);
 * 2. o estabelecimento tem a modalidade habilitada para produção (esta entidade).
 * Estabelecimento novo nasce só com homologação. Habilitar e revogar são atos auditados.
 *
 * As condições abaixo são de CADASTRO, não fiscais: o motor não decide enquadramento tributário
 * (ADR-0018). Elas só impedem habilitar um estabelecimento que ainda não consegue emitir.
 *
 * Ciclo: ACTIVE → REVOKED. Habilitar de novo cria outro registro (o histórico fica).
 */
export const ENABLEMENT_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type EnablementStatus = (typeof ENABLEMENT_STATUSES)[number];

export const MAX_REVOCATION_REASON_LENGTH = 300;

export interface ProductionEnablement {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly kind: DocumentKind;
  readonly status: EnablementStatus;
  readonly enabledAt: Date;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
}

export type NewProductionEnablement = Pick<ProductionEnablement, 'id' | 'companyId' | 'establishmentId' | 'kind'>;

/** O que o cadastro sabe sobre o estabelecimento no momento do pedido. */
export interface EnablementPrerequisites {
  readonly establishment: { readonly cnpj: string; readonly status: 'ACTIVE' | 'INACTIVE' };
  /** Há certificado ACTIVE e dentro da validade para o estabelecimento. */
  readonly hasUsableCertificate: boolean;
  /** Há série ACTIVE de PRODUÇÃO da modalidade no estabelecimento. */
  readonly hasActiveProductionSeries: boolean;
}

/**
 * Confere os pré-requisitos (regra PROD-001, docs/fiscal/regras/PROD-001.md). `confirmCnpj` é a
 * confirmação explícita: o cliente repete o CNPJ do estabelecimento, como proteção contra
 * habilitar o estabelecimento errado por engano de id.
 */
export function checkEnablement(prerequisites: EnablementPrerequisites, confirmCnpj: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = confirmCnpj.replace(/[./\-\s]/g, '').toUpperCase();
  if (normalized !== prerequisites.establishment.cnpj) {
    issues.push({
      code: 'PRODUCTION_CONFIRMATION_MISMATCH',
      field: 'confirmCnpj',
      message: 'O CNPJ de confirmação não é o do estabelecimento.',
      ruleId: 'PROD-001',
    });
  }
  if (prerequisites.establishment.status !== 'ACTIVE') {
    issues.push({ code: 'ESTABLISHMENT_INACTIVE', message: 'O estabelecimento está inativo.', ruleId: 'PROD-001' });
  }
  if (!prerequisites.hasUsableCertificate) {
    issues.push({
      code: 'PRODUCTION_CERTIFICATE_REQUIRED',
      message: 'O estabelecimento precisa de um certificado ACTIVE e dentro da validade.',
      ruleId: 'PROD-001',
    });
  }
  if (!prerequisites.hasActiveProductionSeries) {
    issues.push({
      code: 'PRODUCTION_SERIES_REQUIRED',
      field: 'kind',
      message: 'O estabelecimento precisa de uma série ACTIVE de produção (PRODUCTION) desta modalidade.',
      ruleId: 'PROD-001',
    });
  }
  return issues;
}

export function normalizeRevocationReason(reason: string): { ok: true; value: string } | { ok: false; issue: ValidationIssue } {
  const value = reason.trim().replace(/\s+/g, ' ');
  if (value.length === 0 || value.length > MAX_REVOCATION_REASON_LENGTH) {
    return {
      ok: false,
      issue: { code: 'INVALID_LENGTH', field: 'reason', message: `Deve ter de 1 a ${MAX_REVOCATION_REASON_LENGTH} caracteres.` },
    };
  }
  return { ok: true, value };
}
