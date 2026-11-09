import { err, ok, type Result } from './result.js';
import type { ValidationIssue } from './validation-issue.js';

/**
 * CNPJ numérico e alfanumérico.
 *
 * Regra: docs/fiscal/regras/CNPJ-001.md
 * - 12 posições alfanuméricas (A–Z, 0–9) + 2 dígitos verificadores numéricos.
 * - Valor de cada caractere = código ASCII − 48 ('0'..'9' → 0..9, 'A' → 17 … 'Z' → 42).
 * - DV por módulo 11, pesos 2..9 da direita para a esquerda; resto < 2 → 0, senão 11 − resto.
 * Fonte: IN RFB nº 2.229/2024 e orientação técnica da RFB sobre o CNPJ alfanumérico.
 */
export class Cnpj {
  private constructor(private readonly digits: string) {}

  static parse(input: string): Result<Cnpj, ValidationIssue> {
    const normalized = input.replace(/[.\-/\s]/g, '').toUpperCase();

    if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(normalized)) {
      return err({
        code: 'CNPJ_INVALID_FORMAT',
        message: 'CNPJ deve ter 12 caracteres alfanuméricos seguidos de 2 dígitos verificadores.',
        ruleId: 'CNPJ-001',
      });
    }
    if (/^(.)\1{13}$/.test(normalized)) {
      return err({
        code: 'CNPJ_REPEATED_SEQUENCE',
        message: 'CNPJ com todos os caracteres iguais não é válido.',
        ruleId: 'CNPJ-001',
      });
    }

    const base = normalized.slice(0, 12);
    const dv1 = checkDigit(base);
    const dv2 = checkDigit(base + String(dv1));
    if (normalized.slice(12) !== `${dv1}${dv2}`) {
      return err({
        code: 'CNPJ_INVALID_CHECK_DIGITS',
        message: 'Dígitos verificadores do CNPJ não conferem.',
        ruleId: 'CNPJ-001',
      });
    }
    return ok(new Cnpj(normalized));
  }

  /** 14 caracteres, sem máscara. */
  get value(): string {
    return this.digits;
  }

  /** Raiz (8 primeiras posições): identifica a empresa; matriz e filiais compartilham. */
  get root(): string {
    return this.digits.slice(0, 8);
  }

  get isAlphanumeric(): boolean {
    return /[A-Z]/.test(this.digits);
  }

  formatted(): string {
    const d = this.digits;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  equals(other: Cnpj): boolean {
    return this.digits === other.digits;
  }

  toString(): string {
    return this.digits;
  }
}

function checkDigit(chars: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = chars.length - 1; i >= 0; i--) {
    sum += (chars.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Exposto apenas para geração de dados de teste. */
export function computeCnpjCheckDigits(base12: string): string {
  const dv1 = checkDigit(base12);
  return `${dv1}${checkDigit(base12 + String(dv1))}`;
}
