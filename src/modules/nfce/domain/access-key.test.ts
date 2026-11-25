import { describe, expect, it } from 'vitest';
import { computeCnpjCheckDigits } from '../../../shared/domain/cnpj.js';
import { accessKeyCheckDigit, buildAccessKey, isAcceptableNumericCode, isValidAccessKey } from './access-key.js';

/** Chave de acesso (ADR-0065). Os CNPJ e números abaixo são FICTÍCIOS. */
const CNPJ = '11222333000181';
const parts = { cUF: '22', yearMonth: '2611', cnpj: CNPJ, model: '65' as const, series: 1, number: 1, emissionType: '1', numericCode: '10000001' };

describe('chave de acesso da NF-e/NFC-e 4.00', () => {
  it('módulo 11: o exemplo do MOC 7.0 (item 2.2.6) dá DV 5', () => {
    expect(accessKeyCheckDigit('5206043300991100250655012000000780026730161')).toBe('5');
  });

  it('resto 0 ou 1 dá DV 0', () => {
    // Prova pela própria definição: procura bases com resto 0 e 1 e confere o 0.
    const bases = Array.from({ length: 200 }, (_, i) => `2211${String(i).padStart(39, '0')}`);
    const zero = bases.filter((b) => accessKeyCheckDigit(b) === '0');
    expect(zero.length).toBeGreaterThan(0);
    for (const b of zero) {
      let sum = 0;
      let w = 2;
      for (let i = b.length - 1; i >= 0; i--) {
        sum += Number(b[i]) * w;
        w = w === 9 ? 2 : w + 1;
      }
      expect(sum % 11).toBeLessThan(2);
    }
  });

  it('monta a chave na ordem da Tabela 2-1 e o Id com o prefixo NFe', () => {
    const key = buildAccessKey(parts);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(key.value.value).toHaveLength(44);
    expect(key.value.value.slice(0, 43)).toBe(`222611${CNPJ}65001000000001110000001`);
    expect(key.value.id).toBe(`NFe${key.value.value}`);
    expect(isValidAccessKey(key.value.value)).toBe(true);
    expect(isValidAccessKey(`${key.value.value.slice(0, 43)}${(Number(key.value.checkDigit) + 1) % 10}`)).toBe(false);
  });

  it('CNPJ alfanumérico (NT Conjunta 2025.001): letras valem ASCII − 48 no módulo 11', () => {
    const base12 = '12ABC34S0001';
    const cnpj = base12 + computeCnpjCheckDigits(base12);
    const key = buildAccessKey({ ...parts, cnpj });
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(key.value.value).toMatch(/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/);
    // A=17, B=18, C=19, S=35: o mesmo cálculo, caractere a caractere.
    let sum = 0;
    let w = 2;
    const base = key.value.value.slice(0, 43);
    for (let i = base.length - 1; i >= 0; i--) {
      sum += (base.charCodeAt(i) - 48) * w;
      w = w === 9 ? 2 : w + 1;
    }
    expect(key.value.checkDigit).toBe(sum % 11 < 2 ? '0' : String(11 - (sum % 11)));
  });

  it('B03-10 (NT 2019.001): cNF proibido ou igual ao nNF é recusado', () => {
    for (const code of ['00000000', '99999999', '12345678', '01234567']) {
      expect(isAcceptableNumericCode(code, 5)).toBe(false);
      expect(buildAccessKey({ ...parts, numericCode: code })).toEqual({ ok: false, error: 'ACCESS_KEY_INVALID_NUMERIC_CODE' });
    }
    expect(isAcceptableNumericCode('00000042', 42)).toBe(false);
    expect(isAcceptableNumericCode('00000042', 43)).toBe(true);
    expect(isAcceptableNumericCode('1234567', 1)).toBe(false);
  });

  it('campos fora do formato são recusados', () => {
    expect(buildAccessKey({ ...parts, cUF: '99' })).toMatchObject({ error: 'ACCESS_KEY_INVALID_UF' });
    expect(buildAccessKey({ ...parts, yearMonth: '2613' })).toMatchObject({ error: 'ACCESS_KEY_INVALID_YEAR_MONTH' });
    expect(buildAccessKey({ ...parts, cnpj: '11222333000180' })).toMatchObject({ error: 'ACCESS_KEY_INVALID_CNPJ' });
    expect(buildAccessKey({ ...parts, series: 1000 })).toMatchObject({ error: 'ACCESS_KEY_INVALID_SERIES' });
    expect(buildAccessKey({ ...parts, number: 0 })).toMatchObject({ error: 'ACCESS_KEY_INVALID_NUMBER' });
    expect(buildAccessKey({ ...parts, number: 1_000_000_000 })).toMatchObject({ error: 'ACCESS_KEY_INVALID_NUMBER' });
    expect(buildAccessKey({ ...parts, emissionType: '10' })).toMatchObject({ error: 'ACCESS_KEY_INVALID_EMISSION_TYPE' });
  });
});
