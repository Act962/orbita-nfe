import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Cnpj, computeCnpjCheckDigits } from './cnpj.js';

// Fonte: docs/fiscal/regras/CNPJ-001.md
describe('Cnpj', () => {
  it('aceita CNPJ numérico válido com e sem máscara', () => {
    for (const input of ['11.222.333/0001-81', '11222333000181']) {
      const result = Cnpj.parse(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value).toBe('11222333000181');
        expect(result.value.isAlphanumeric).toBe(false);
      }
    }
  });

  it('aceita o exemplo de CNPJ alfanumérico publicado pela RFB', () => {
    const result = Cnpj.parse('12.ABC.345/01DE-35');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe('12ABC34501DE35');
      expect(result.value.isAlphanumeric).toBe(true);
      expect(result.value.root).toBe('12ABC345');
      expect(result.value.formatted()).toBe('12.ABC.345/01DE-35');
    }
  });

  it('normaliza letras minúsculas para maiúsculas', () => {
    const result = Cnpj.parse('12abc34501de35');
    expect(result.ok && result.value.value).toBe('12ABC34501DE35');
  });

  it.each([
    ['11222333000182', 'CNPJ_INVALID_CHECK_DIGITS'],
    ['12ABC34501DE36', 'CNPJ_INVALID_CHECK_DIGITS'],
    ['1122233300018', 'CNPJ_INVALID_FORMAT'],
    ['112223330001811', 'CNPJ_INVALID_FORMAT'],
    ['12ABC34501DEAB', 'CNPJ_INVALID_FORMAT'], // DV sempre numérico
    ['12ABC345@1DE35', 'CNPJ_INVALID_FORMAT'],
    ['00000000000000', 'CNPJ_REPEATED_SEQUENCE'],
    ['', 'CNPJ_INVALID_FORMAT'],
  ])('rejeita %s com %s', (input, code) => {
    const result = Cnpj.parse(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('propriedade: toda base alfanumérica com DV calculado é aceita e preserva a raiz', () => {
    const char = fc.constantFrom(...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    fc.assert(
      fc.property(fc.array(char, { minLength: 12, maxLength: 12 }), (chars) => {
        const base = chars.join('');
        fc.pre(!/^(.)\1{11}$/.test(base));
        const result = Cnpj.parse(base + computeCnpjCheckDigits(base));
        return result.ok && result.value.root === base.slice(0, 8);
      }),
    );
  });

  it('propriedade: alterar um dígito verificador sempre invalida', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Z]{12}$/), fc.integer({ min: 1, max: 9 }), (base, delta) => {
        fc.pre(!/^(.)\1{11}$/.test(base));
        const dv = computeCnpjCheckDigits(base);
        const wrong = String((Number(dv[1]) + delta) % 10);
        return !Cnpj.parse(base + dv.charAt(0) + wrong).ok;
      }),
    );
  });
});
