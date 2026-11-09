import { Decimal as DecimalJs } from 'decimal.js';
import { err, ok, type Result } from './result.js';
import type { ValidationIssue } from './validation-issue.js';

/**
 * Número decimal exato para valores fiscais. Nunca usar `number` para dinheiro,
 * quantidades ou alíquotas (ADR-0003).
 *
 * - Construído apenas a partir de string ("1234.50"), sem notação exponencial.
 * - Arredondamento sempre explícito: a regra de arredondamento é fiscal e varia por campo,
 *   então não existe modo padrão (docs/architecture/14 §A6).
 */
const D = DecimalJs.clone({ precision: 50, toExpNeg: -50, toExpPos: 50 });

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

const ROUNDING: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: D.ROUND_HALF_UP,
  HALF_EVEN: D.ROUND_HALF_EVEN,
  DOWN: D.ROUND_DOWN,
  UP: D.ROUND_UP,
};

const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export class Decimal {
  private constructor(private readonly inner: DecimalJs) {}

  static parse(input: string, field?: string): Result<Decimal, ValidationIssue> {
    if (!DECIMAL_PATTERN.test(input)) {
      return err({
        code: 'DECIMAL_INVALID_FORMAT',
        message: 'Valor decimal deve usar ponto como separador, sem sinal "+", zeros à esquerda ou expoente (ex.: "1234.50").',
        ...(field === undefined ? {} : { field }),
      });
    }
    return ok(new Decimal(new D(input)));
  }

  /** Para constantes no código e em testes. Lança erro se o literal for inválido. */
  static of(literal: string): Decimal {
    const result = Decimal.parse(literal);
    if (!result.ok) throw new Error(`Literal decimal inválido: ${literal}`);
    return result.value;
  }

  static zero(): Decimal {
    return new Decimal(new D(0));
  }

  static sum(values: readonly Decimal[]): Decimal {
    return values.reduce((acc, v) => acc.plus(v), Decimal.zero());
  }

  plus(other: Decimal): Decimal {
    return new Decimal(this.inner.plus(other.inner));
  }

  minus(other: Decimal): Decimal {
    return new Decimal(this.inner.minus(other.inner));
  }

  times(other: Decimal): Decimal {
    return new Decimal(this.inner.times(other.inner));
  }

  round(scale: number, mode: RoundingMode): Decimal {
    return new Decimal(this.inner.toDecimalPlaces(scale, ROUNDING[mode]));
  }

  /** Casas decimais significativas do valor informado. */
  get scale(): number {
    return this.inner.decimalPlaces();
  }

  isNegative(): boolean {
    return this.inner.isNegative() && !this.inner.isZero();
  }

  isZero(): boolean {
    return this.inner.isZero();
  }

  compare(other: Decimal): -1 | 0 | 1 {
    return this.inner.comparedTo(other.inner) as -1 | 0 | 1;
  }

  equals(other: Decimal): boolean {
    return this.inner.equals(other.inner);
  }

  /** Diferença absoluta menor ou igual à tolerância informada. */
  equalsWithin(other: Decimal, tolerance: Decimal): boolean {
    return this.inner.minus(other.inner).abs().lessThanOrEqualTo(tolerance.inner);
  }

  /** Representação com escala fixa, sem arredondar: exige que o valor já caiba na escala. */
  toFixed(scale: number): string {
    if (this.scale > scale) {
      throw new Error(`Valor com ${this.scale} casas não cabe em ${scale} casas; arredonde explicitamente antes.`);
    }
    return this.inner.toFixed(scale);
  }

  toString(): string {
    return this.inner.toFixed();
  }
}
