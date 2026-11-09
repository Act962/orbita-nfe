/**
 * Problema de validação com código estável (consumido pela API e pelos testes).
 * `ruleId` aponta para docs/fiscal/regras/<ruleId>.md quando a regra tem origem fiscal.
 */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly ruleId?: string;
}
