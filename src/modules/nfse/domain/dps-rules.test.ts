import { describe, expect, it } from 'vitest';
import type { DpsData } from './dps.js';
import { checkDpsRules, DPS_RULES, hundredths, type DpsRuleContext, type RuleEnvironment } from './dps-rules.js';

const PROVIDER = '11222333000181';
/** CNPJ com DV válido, diferente do prestador. */
const OTHER_CNPJ = '11444777000161';

/** DPS que não viola nenhuma regra: ME/EPP no Simples, tributável, sem retenção, sem tomador. */
const base: DpsData = {
  competenceDate: '2026-11-10',
  provider: { simplesNacionalOption: '3', simplesNacionalRegime: '1', specialTaxRegime: '0' },
  service: { municipalityCode: '2211001', nationalTaxCode: '010101', description: 'Serviço' },
  values: { serviceAmount: '1000.00', issqn: { taxation: '1', retention: '1' }, approximateTaxes: { kind: 'AMOUNTS', federal: '10.00', state: '0.00', municipal: '20.00' } },
};

const ctx = (environment: RuleEnvironment = 'HOMOLOGATION'): DpsRuleContext => ({ environment, providerCnpj: PROVIDER, issueDate: '2026-11-13' });
const codes = (d: DpsData, environment: RuleEnvironment = 'HOMOLOGATION') => checkDpsRules(d, ctx(environment)).map((v) => v.code);

const mei = (d: DpsData = base): DpsData => ({ ...d, provider: { simplesNacionalOption: '2', specialTaxRegime: '0' } });
const notOptant = (d: DpsData = base): DpsData => ({ ...d, provider: { simplesNacionalOption: '1', specialTaxRegime: '0' } });
const issqn = (d: DpsData, change: Partial<DpsData['values']['issqn']>): DpsData => ({ ...d, values: { ...d.values, issqn: { ...d.values.issqn, ...change } } });
const service = (d: DpsData, change: Partial<DpsData['service']>): DpsData => ({ ...d, service: { ...d.service, ...change } });
const taxes = (d: DpsData, approximateTaxes: DpsData['values']['approximateTaxes']): DpsData => ({ ...d, values: { ...d.values, approximateTaxes } });
const cpfTaker = { document: { type: 'CPF', value: '12345678909' }, name: 'Tomador' } as const;

describe('regras do Anexo I conferidas no aceite (ADR-0037)', () => {
  it('a DPS de base não viola nenhuma regra nos dois ambientes', () => {
    expect(codes(base, 'HOMOLOGATION')).toEqual([]);
    expect(codes(base, 'PRODUCTION')).toEqual([]);
  });

  it.each<[string, DpsData, RuleEnvironment[]]>([
    ['E0015', { ...base, competenceDate: '2026-11-14' }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0162', { ...mei(), provider: { simplesNacionalOption: '2', simplesNacionalRegime: '1', specialTaxRegime: '0' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0166', { ...base, provider: { simplesNacionalOption: '3', specialTaxRegime: '0' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0172', { ...issqn(notOptant(), { taxation: '4' }), provider: { simplesNacionalOption: '1', specialTaxRegime: '1' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0174', { ...mei(), provider: { simplesNacionalOption: '2', specialTaxRegime: '6' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0175', { ...base, provider: { simplesNacionalOption: '3', simplesNacionalRegime: '1', specialTaxRegime: '6' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0188', { ...base, taker: { document: { type: 'CNPJ', value: '11222333000182' }, name: 'X' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0202', { ...base, taker: { document: { type: 'CNPJ', value: PROVIDER }, name: 'X' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0204', issqn(base, { retention: '2' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0235', { ...base, taker: { document: { type: 'CNPJ', value: OTHER_CNPJ }, name: 'X' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0237', { ...issqn(base, { retention: '2' }), taker: cpfTaker }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0264', issqn(base, { retention: '3' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E1402', service(base, { nationalTaxCode: '200101', municipalityCode: '0000000' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0309', issqn(service(base, { nationalTaxCode: '990301' }), { taxation: '4' }), ['HOMOLOGATION']],
    ['E0313', service(mei(), { municipalTaxCode: '001' }), ['HOMOLOGATION']],
    ['E0315', service(base, { municipalTaxCode: '000' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0532', service(base, { nationalTaxCode: '990101' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0592', issqn(base, { taxation: '2' }), ['PRODUCTION']],
    ['E0580', issqn(base, { taxation: '3', retention: '2' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0583', { ...issqn(mei(), { retention: '2' }), taker: cpfTaker }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0588', { ...issqn(notOptant(), { retention: '2' }), provider: { simplesNacionalOption: '1', specialTaxRegime: '1' }, taker: cpfTaker }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0596', { ...issqn(service(base, { nationalTaxCode: '220101' }), { retention: '2' }), taker: cpfTaker }, ['PRODUCTION']],
    ['E0595', issqn(base, { rate: '5.01' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0600', issqn(mei(), { rate: '2.00' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0602', issqn(base, { taxation: '4', rate: '2.00' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0604', { ...issqn(notOptant(), { rate: '2.00' }), provider: { simplesNacionalOption: '1', specialTaxRegime: '1' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0702', taxes(base, { kind: 'AMOUNTS', federal: '1000.01', state: '0', municipal: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0703', taxes(base, { kind: 'AMOUNTS', federal: '0', state: '1000.01', municipal: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0704', taxes(base, { kind: 'AMOUNTS', federal: '0', state: '0', municipal: '1000.01' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0706', taxes(base, { kind: 'PERCENTAGES', federal: '100.01', state: '0', municipal: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0707', taxes(base, { kind: 'PERCENTAGES', federal: '0', state: '100.01', municipal: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0708', taxes(base, { kind: 'PERCENTAGES', federal: '0', state: '0', municipal: '100.01' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0710', taxes(mei(), { kind: 'SIMPLES_NACIONAL_RATE', rate: '6.00' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0712', taxes(base, { kind: 'NOT_INFORMED' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0713', taxes(notOptant(), { kind: 'SIMPLES_NACIONAL_RATE', rate: '6.00' }), ['PRODUCTION', 'HOMOLOGATION']],
  ])('%s: violada só nos ambientes em que a fonte a traz', (code, dps, environments) => {
    for (const environment of ['PRODUCTION', 'HOMOLOGATION'] as const) {
      expect(codes(dps, environment).includes(code), `${code} em ${environment}`).toBe(environments.includes(environment));
    }
  });

  it('limites: igual ao limite passa (competência hoje, 5%, 100%, total igual ao serviço)', () => {
    expect(codes({ ...base, competenceDate: '2026-11-13' })).toEqual([]);
    expect(codes(issqn(base, { rate: '5.00' }))).toEqual([]);
    expect(codes(taxes(base, { kind: 'PERCENTAGES', federal: '100.00', state: '100', municipal: '0' }))).toEqual([]);
    expect(codes(taxes(base, { kind: 'AMOUNTS', federal: '1000', state: '1000.00', municipal: '0' }))).toEqual([]);
  });

  it('E0532: na produção só 99.01.01; na produção restrita qualquer 99.XX.XX', () => {
    const other99 = service(base, { nationalTaxCode: '990201' });
    expect(codes(other99, 'PRODUCTION')).not.toContain('E0532');
    expect(codes(other99, 'HOMOLOGATION')).toContain('E0532');
  });

  it('devolve todas as violações de uma vez, com o campo', () => {
    const many = { ...issqn(mei(), { retention: '3', rate: '6.00' }), competenceDate: '2026-12-01' };
    expect(checkDpsRules(many, ctx()).map((v) => [v.code, v.field])).toEqual([
      ['E0015', 'competenceDate'],
      ['E0264', 'values.issqn.retention'],
      ['E0583', 'values.issqn.retention'],
      ['E0595', 'values.issqn.rate'],
      ['E0600', 'values.issqn.rate'],
    ]);
  });

  it('cada regra tem código do Anexo I, campo, mensagem e ao menos um ambiente', () => {
    for (const rule of DPS_RULES) {
      expect(rule.code).toMatch(/^E[0-9]{4}$/);
      expect(rule.field).not.toBe('');
      expect(rule.message.length).toBeGreaterThan(10);
      expect(rule.environments.length).toBeGreaterThan(0);
    }
  });

  it('decimais em centésimos sem ponto flutuante', () => {
    expect(hundredths('0')).toBe(0n);
    expect(hundredths('1500')).toBe(150_000n);
    expect(hundredths('0.10')).toBe(10n);
    expect(hundredths('999999999999999.99')).toBe(99_999_999_999_999_999n);
  });
});
