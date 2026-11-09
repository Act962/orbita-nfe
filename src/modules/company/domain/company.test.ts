import { describe, expect, it } from 'vitest';
import { computeCnpjCheckDigits } from '../../../shared/domain/cnpj.js';
import { newEstablishment, newCompany } from './company.js';

const cnpjWithRoot = (root: string, branch = '0001'): string => {
  const base = root + branch;
  return base + computeCnpjCheckDigits(base);
};

describe('newCompany', () => {
  it('normaliza nome e raiz', () => {
    const r = newCompany({ id: 't1', legalName: '  Empresa   Fictícia  LTDA ', rootCnpj: '12.345.678' });
    expect(r).toEqual({ ok: true, value: { id: 't1', legalName: 'Empresa Fictícia LTDA', rootCnpj: '12345678', status: 'ACTIVE' } });
  });

  it('aceita raiz alfanumérica (CNPJ-001)', () => {
    const r = newCompany({ id: 't1', legalName: 'X', rootCnpj: '12abc34s' });
    expect(r.ok && r.value.rootCnpj).toBe('12ABC34S');
  });

  it('lista todos os problemas', () => {
    const r = newCompany({ id: 't1', legalName: ' ', rootCnpj: '123' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((i) => i.code)).toEqual(['INVALID_LENGTH', 'CNPJ_INVALID_ROOT']);
  });
});

describe('newEstablishment', () => {
  const company = { id: 't1', rootCnpj: '12345678' };

  it('cria com a mesma raiz da empresa', () => {
    const cnpj = cnpjWithRoot('12345678', '0002');
    const r = newEstablishment(company, { id: 'e1', cnpj, tradeName: 'Filial', municipalityCode: '2211001' });
    expect(r).toEqual({ ok: true, value: { id: 'e1', companyId: 't1', cnpj, tradeName: 'Filial', municipalityCode: '2211001', status: 'ACTIVE' } });
  });

  it('COMPANY-001: raiz diferente é recusada', () => {
    const r = newEstablishment(company, { id: 'e1', cnpj: cnpjWithRoot('87654321'), tradeName: 'X', municipalityCode: '2211001' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'ROOT_MISMATCH', issue: { code: 'ESTABLISHMENT_ROOT_MISMATCH', ruleId: 'COMPANY-001' } } });
  });

  it('CNPJ com DV errado e município inválido → problemas de validação com campo', () => {
    const r = newEstablishment(company, { id: 'e1', cnpj: '12345678000100', tradeName: 'X', municipalityCode: '221' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'INVALID') {
      expect(r.error.issues).toEqual([
        expect.objectContaining({ code: 'CNPJ_INVALID_CHECK_DIGITS', field: 'cnpj', ruleId: 'CNPJ-001' }),
        expect.objectContaining({ code: 'INVALID_MUNICIPALITY_CODE', field: 'municipalityCode' }),
      ]);
    }
  });
});
