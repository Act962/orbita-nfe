import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from './decimal.js';

describe('Decimal', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(Decimal.of('0.1').plus(Decimal.of('0.2')).toString()).toBe('0.3');
  });

  it.each(['1234.50', '0', '-10.25', '0.0000000001', '99999999999999.99'])('aceita %s', (input) => {
    expect(Decimal.parse(input).ok).toBe(true);
  });

  it.each(['1,50', '1e3', '+1', '01.5', '.5', '1.', '', ' 1', 'NaN', 'Infinity'])('rejeita %s', (input) => {
    const result = Decimal.parse(input, 'values.serviceAmount');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DECIMAL_INVALID_FORMAT');
      expect(result.error.field).toBe('values.serviceAmount');
    }
  });

  it('arredondamento é explícito e respeita o modo', () => {
    expect(Decimal.of('2.345').round(2, 'HALF_UP').toString()).toBe('2.35');
    expect(Decimal.of('2.345').round(2, 'HALF_EVEN').toString()).toBe('2.34');
    expect(Decimal.of('2.349').round(2, 'DOWN').toString()).toBe('2.34');
    expect(Decimal.of('2.341').round(2, 'UP').toString()).toBe('2.35');
  });

  it('toFixed não arredonda silenciosamente', () => {
    expect(Decimal.of('10.5').toFixed(2)).toBe('10.50');
    expect(() => Decimal.of('10.555').toFixed(2)).toThrow(/arredonde explicitamente/);
  });

  it('compara com tolerância', () => {
    expect(Decimal.of('100.00').equalsWithin(Decimal.of('100.01'), Decimal.of('0.01'))).toBe(true);
    expect(Decimal.of('100.00').equalsWithin(Decimal.of('100.02'), Decimal.of('0.01'))).toBe(false);
  });

  it('identifica zero e negativos (incluindo -0)', () => {
    expect(Decimal.of('-0').isNegative()).toBe(false);
    expect(Decimal.of('-0').isZero()).toBe(true);
    expect(Decimal.of('-0.01').isNegative()).toBe(true);
  });

  it('propriedade: soma de centavos é exata e comutativa', () => {
    const cents = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((n) => {
      const s = n.toString().padStart(3, '0');
      return `${String(BigInt(s.slice(0, -2)))}.${s.slice(-2)}`;
    });
    fc.assert(
      fc.property(fc.array(cents, { maxLength: 50 }), (values) => {
        const decimals = values.map((v) => Decimal.of(v));
        const expected = values.reduce((acc, v) => acc + BigInt(v.replace('.', '')), 0n);
        const total = Decimal.sum(decimals);
        const reversed = Decimal.sum([...decimals].reverse());
        return total.equals(reversed) && total.times(Decimal.of('100')).toString() === expected.toString();
      }),
    );
  });
});
