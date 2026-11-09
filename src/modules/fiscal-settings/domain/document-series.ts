import { err, ok, type Result } from '../../../shared/domain/result.js';
import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';

/**
 * Série de documentos fiscais de um estabelecimento (docs/architecture/02 §3; ADR-0008).
 *
 * A série é única por (estabelecimento, modalidade, ambiente, série). O próximo número só
 * avança (trigger no banco) e nunca é reutilizado: lacunas são tratadas pela modalidade
 * (inutilização na NF-e/NFC-e; NFS-e conforme manual nacional — pendente, R-08).
 *
 * Limites de série e número por modalidade:
 * - SERIES-001 (NF-e/NFC-e): docs/fiscal/regras/SERIES-001.md
 * - SERIES-002 (DPS da NFS-e Nacional): docs/fiscal/regras/SERIES-002.md (PROVISÓRIA: conferir no XSD na Fase 2a)
 */
export const DOCUMENT_KINDS = ['NFSE_DPS', 'NFE', 'NFCE'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const FISCAL_ENVIRONMENTS = ['PRODUCTION', 'HOMOLOGATION'] as const;
export type FiscalEnvironment = (typeof FISCAL_ENVIRONMENTS)[number];

export type SeriesStatus = 'ACTIVE' | 'INACTIVE';

interface SeriesLimits {
  readonly series: RegExp;
  readonly seriesDescription: string;
  readonly maxNumber: number;
  readonly ruleId: string;
}

const LIMITS: Record<DocumentKind, SeriesLimits> = {
  NFE: { series: /^(0|[1-9][0-9]{0,2})$/, seriesDescription: 'de 0 a 999', maxNumber: 999_999_999, ruleId: 'SERIES-001' },
  NFCE: { series: /^(0|[1-9][0-9]{0,2})$/, seriesDescription: 'de 0 a 999', maxNumber: 999_999_999, ruleId: 'SERIES-001' },
  NFSE_DPS: { series: /^(0|[1-9][0-9]{0,3}|[1-8][0-9]{4})$/, seriesDescription: 'de 0 a 89999', maxNumber: 999_999_999_999_999, ruleId: 'SERIES-002' },
};

export function limitsOf(kind: DocumentKind): SeriesLimits {
  return LIMITS[kind];
}

export interface DocumentSeries {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly kind: DocumentKind;
  readonly environment: FiscalEnvironment;
  readonly series: string;
  /** Próximo número a ser alocado. */
  readonly nextNumber: number;
  /** Último número permitido pela modalidade. */
  readonly maxNumber: number;
  readonly status: SeriesStatus;
  readonly createdAt: Date;
}

export type NewDocumentSeries = Omit<DocumentSeries, 'createdAt'>;

export function newDocumentSeries(input: {
  id: string;
  companyId: string;
  establishmentId: string;
  kind: DocumentKind;
  environment: FiscalEnvironment;
  series: string;
  nextNumber?: number | undefined;
}): Result<NewDocumentSeries, ValidationIssue[]> {
  const limits = LIMITS[input.kind];
  const issues: ValidationIssue[] = [];
  // Sem zeros à esquerda: "1" e "001" seriam a mesma série no documento e duas no cadastro.
  if (!limits.series.test(input.series)) {
    issues.push({
      code: 'INVALID_SERIES',
      field: 'series',
      message: `Série deve ser um número ${limits.seriesDescription}, sem zeros à esquerda.`,
      ruleId: limits.ruleId,
    });
  }
  const nextNumber = input.nextNumber ?? 1;
  if (!Number.isSafeInteger(nextNumber) || nextNumber < 1 || nextNumber > limits.maxNumber) {
    issues.push({
      code: 'INVALID_NEXT_NUMBER',
      field: 'nextNumber',
      message: `Próximo número deve estar entre 1 e ${limits.maxNumber}.`,
      ruleId: limits.ruleId,
    });
  }
  if (issues.length > 0) return err(issues);
  return ok({
    id: input.id,
    companyId: input.companyId,
    establishmentId: input.establishmentId,
    kind: input.kind,
    environment: input.environment,
    series: input.series,
    nextNumber,
    maxNumber: limits.maxNumber,
    status: 'ACTIVE',
  });
}

export type NumberAllocation =
  | { readonly kind: 'ALLOCATED'; readonly number: number }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INACTIVE' }
  | { readonly kind: 'EXHAUSTED' };
