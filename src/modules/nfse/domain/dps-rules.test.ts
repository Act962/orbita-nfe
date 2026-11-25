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
const values = (d: DpsData, change: Partial<DpsData['values']>): DpsData => ({ ...d, values: { ...d.values, ...change } });
/** nBM fictício no formato do XSD (IBGE + tipo 04 + sequencial). */
const BM_ID = '22110010400001';
const PROCESS = '1'.repeat(30);
const cpfTaker = { document: { type: 'CPF', value: '12345678909' }, name: 'Tomador' } as const;
const ADDRESS = { municipalityCode: '2211001', postalCode: '64000000', street: 'Rua Fictícia', number: '100', district: 'Centro' } as const;
const intermediary = (value: string) => ({ document: { type: 'CNPJ', value }, name: 'Intermediário' }) as const;
const FOREIGN = { countryCode: 'PT', postalCode: '1000-001', city: 'Lisboa', region: 'Lisboa', street: 'Rua Fictícia', number: '1', district: 'Centro' } as const;
const foreignTaker = { document: { type: 'NIF', value: 'PT123456789' }, name: 'Cliente no exterior', address: FOREIGN } as const;
const TRADE: NonNullable<DpsData['service']['foreignTrade']> = {
  mode: '1',
  relationship: '0',
  currencyCode: '978',
  amountInCurrency: '180.00',
  providerSupport: '01',
  takerSupport: '01',
  temporaryGoods: '1',
  shareWithMdic: false,
};
/** Com o grupo comExt (E0330) e o cNBS (E0318), o comExt opcionalmente alterado. */
const exported = (d: DpsData, change: Partial<typeof TRADE> = {}): DpsData => ({
  ...d,
  service: { ...d.service, nbsCode: '115011000', foreignTrade: { ...TRADE, ...change } },
});

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
    // Contrato v2 (ADR-0040).
    ['E0248', { ...base, intermediary: intermediary('11444777000162') }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0262', { ...base, intermediary: intermediary('11222333000262') }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0593', issqn(base, { taxation: '2', immunityType: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0592', issqn(base, { immunityType: '1' }), ['PRODUCTION']],
    // Descontos e tributos federais (ADR-0041).
    ['E0431', values(base, { discounts: { unconditional: '0.00' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0431', values(base, { discounts: { unconditional: '1000.00' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0432', values(base, { discounts: { conditional: '0' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0432', values(base, { discounts: { conditional: '1000.01' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0428', values(base, { discounts: { unconditional: '600.00', conditional: '300.00' }, federalTaxes: { incomeTaxWithheld: '100.01' } }), ['PRODUCTION', 'HOMOLOGATION']],
    // Dedução/redução da BC (ADR-0042).
    ['E0435', issqn(values(base, { deduction: { kind: 'AMOUNT', amount: '10.00' } }), { taxation: '4' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0436', values(mei(), { deduction: { kind: 'PERCENTAGE', rate: '10.00' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0438', { ...values(notOptant(), { deduction: { kind: 'AMOUNT', amount: '10.00' } }), provider: { simplesNacionalOption: '1', specialTaxRegime: '9' } }, ['PRODUCTION']],
    ['E0445', { ...values(notOptant(), { deduction: { kind: 'AMOUNT', amount: '10.00' } }), provider: { simplesNacionalOption: '1', specialTaxRegime: '1' } }, ['HOMOLOGATION']],
    ['E0453', values(base, { deduction: { kind: 'PERCENTAGE', rate: '0' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0453', values(base, { deduction: { kind: 'PERCENTAGE', rate: '100.01' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0427', values(base, { discounts: { unconditional: '400.00' }, deduction: { kind: 'AMOUNT', amount: '600.01' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0427', issqn(values(base, { discounts: { unconditional: '400.00' } }), { municipalBenefit: { id: BM_ID, reduction: { kind: 'AMOUNT', amount: '600.01' } } }), ['PRODUCTION', 'HOMOLOGATION']],
    // Exigibilidade suspensa e benefício municipal (ADR-0043).
    ['E0585', issqn(base, { taxation: '4', suspension: { type: '1', processNumber: PROCESS } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0533', issqn(base, { taxation: '3', municipalBenefit: { id: BM_ID } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0534', issqn(mei(), { municipalBenefit: { id: BM_ID } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0535', { ...issqn(notOptant(), { municipalBenefit: { id: BM_ID } }), provider: { simplesNacionalOption: '1', specialTaxRegime: '9' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0574', issqn(base, { municipalBenefit: { id: BM_ID, reduction: { kind: 'AMOUNT', amount: '1000.01' } } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0586', issqn(base, { municipalBenefit: { id: BM_ID, reduction: { kind: 'PERCENTAGE', rate: '0.00' } } }), ['PRODUCTION', 'HOMOLOGATION']],
    // Tomador e intermediário no exterior, comércio exterior (ADR-0044).
    ['E1388', { ...base, intermediary: { ...intermediary(OTHER_CNPJ), address: FOREIGN } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0293', { ...issqn(base, { retention: '3' }), intermediary: { document: { type: 'CPF', value: '12345678909' }, name: 'I' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0223', exported({ ...base, taker: { document: { type: 'CPF', value: '12345678909' }, name: 'T', address: FOREIGN } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0226', exported({ ...base, taker: { document: { type: 'NO_NIF', reason: '0' }, name: 'T', address: FOREIGN } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0242', { ...base, taker: { document: { type: 'NIF', value: 'X1' }, name: 'T' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0242', { ...base, taker: { document: { type: 'NO_NIF', reason: '1' }, name: 'T' } }, ['HOMOLOGATION']],
    ['E0246', exported({ ...base, taker: { ...foreignTaker, address: { ...FOREIGN, countryCode: 'BR' } } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0246', exported({ ...base, taker: { ...foreignTaker, address: { ...FOREIGN, countryCode: 'ZZ' } } }), ['HOMOLOGATION']],
    ['E0281', exported({ ...base, intermediary: { ...intermediary(OTHER_CNPJ), address: FOREIGN } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0286', exported({ ...base, intermediary: { document: { type: 'NO_NIF', reason: '0' }, name: 'I', address: FOREIGN } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0298', { ...base, intermediary: { document: { type: 'NIF', value: 'X2' }, name: 'I' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0299', exported({ ...base, intermediary: { document: { type: 'NIF', value: 'X2' }, name: 'I', address: { ...FOREIGN, countryCode: 'BR' } } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0330', { ...base, taker: foreignTaker }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0330', issqn(notOptant(), { taxation: '3' }), ['PRODUCTION', 'HOMOLOGATION']],
    // Prestação no exterior (ADR-0045).
    ['E0330', { ...base, service: { ...base.service, municipalityCode: undefined, countryCode: 'PT', nbsCode: '115011000' } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0318', { ...base, taker: foreignTaker, service: { ...base.service, foreignTrade: TRADE } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0318', { ...base, service: { ...base.service, municipalityCode: undefined, countryCode: 'PT', foreignTrade: TRADE } }, ['PRODUCTION', 'HOMOLOGATION']],
    ['E0304', exported({ ...base, service: { ...base.service, municipalityCode: undefined, countryCode: 'BR' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0333', exported({ ...base, taker: foreignTaker }, { mode: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0341', exported({ ...base, taker: foreignTaker }, { providerSupport: '00' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0343', exported({ ...base, taker: foreignTaker }, { takerSupport: '00' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0345', exported({ ...base, taker: foreignTaker }, { temporaryGoods: '0' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0352', exported({ ...base, taker: foreignTaker }, { temporaryGoods: '2' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0354', exported({ ...base, taker: foreignTaker }, { exportRegistration: 'RE1' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0356', exported({ ...base, taker: foreignTaker }, { temporaryGoods: '3' }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0699', values(base, { federalTaxes: { socialSecurityWithheld: '0' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0700', values(base, { federalTaxes: { incomeTaxWithheld: '1000.00' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0701', values(base, { federalTaxes: { contributionsWithheld: '0.00' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0720', values(base, { federalTaxes: { pisCofins: { cst: '01', retentionType: '0' }, contributionsWithheld: '46.50' } }), ['PRODUCTION', 'HOMOLOGATION']],
    ['E0724', values(base, { federalTaxes: { pisCofins: { cst: '01', retentionType: '3' } } }), ['PRODUCTION', 'HOMOLOGATION']],
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

  it('contrato v2: com os grupos que a regra exige, E0235, E0237, E0264 e E0592 deixam de valer', () => {
    const cnpjTaker = { document: { type: 'CNPJ', value: OTHER_CNPJ }, name: 'X', address: ADDRESS } as const;
    expect(codes({ ...base, taker: cnpjTaker }, 'PRODUCTION')).toEqual([]);
    expect(codes({ ...issqn(base, { retention: '2' }), taker: { ...cpfTaker, address: ADDRESS } }, 'PRODUCTION')).toEqual([]);
    // ADR-0044: intermediário com CNPJ e com retenção também exige o endereço nacional (E1388, E0293).
    expect(codes({ ...issqn(base, { retention: '3' }), intermediary: intermediary(OTHER_CNPJ) }, 'PRODUCTION')).toEqual(['E1388', 'E0293']);
    expect(codes({ ...issqn(base, { retention: '3' }), intermediary: { ...intermediary(OTHER_CNPJ), address: ADDRESS } }, 'PRODUCTION')).toEqual([]);
    expect(codes(issqn(base, { taxation: '2', immunityType: '1' }), 'PRODUCTION')).toEqual([]);
  });

  it('descontos e retenções federais dentro dos limites passam (soma igual ao serviço, tipos de retenção 0 e 2 sem vRetCSLL)', () => {
    const full = values(base, {
      discounts: { unconditional: '100.00', conditional: '50.00' },
      federalTaxes: {
        pisCofins: { cst: '01', baseAmount: '1000.00', pisRate: '0.65', cofinsRate: '3.00', pisAmount: '6.50', cofinsAmount: '30.00', retentionType: '3' },
        socialSecurityWithheld: '110.00',
        incomeTaxWithheld: '15.00',
        contributionsWithheld: '725.00',
      },
    });
    expect(codes(full, 'PRODUCTION')).toEqual([]);
    expect(codes(full, 'HOMOLOGATION')).toEqual([]);
    for (const retentionType of ['0', '2'] as const) {
      expect(codes(values(base, { federalTaxes: { pisCofins: { cst: '01', retentionType } } }))).toEqual([]);
    }
    // vRetCSLL sem piscofins: nenhuma das duas regras do tipo de retenção se aplica.
    expect(codes(values(base, { federalTaxes: { contributionsWithheld: '10.00' } }))).toEqual([]);
  });

  it('dedução dentro dos limites passa: 100%, valor que fecha o serviço com o desconto; regEspTrib 9 na produção restrita fica com o autorizador', () => {
    expect(codes(values(base, { deduction: { kind: 'PERCENTAGE', rate: '100.00' } }), 'PRODUCTION')).toEqual([]);
    expect(codes(values(base, { discounts: { unconditional: '400.00' }, deduction: { kind: 'AMOUNT', amount: '600.00' } }), 'HOMOLOGATION')).toEqual([]);
    const regime9 = { ...values(notOptant(), { deduction: { kind: 'AMOUNT', amount: '10.00' } }), provider: { simplesNacionalOption: '1', specialTaxRegime: '9' } } as const;
    expect(codes(regime9, 'HOMOLOGATION')).toEqual([]);
  });

  it('exigibilidade suspensa e benefício municipal válidos passam; a soma da E0427 aceita o limite e ignora reduções por percentual', () => {
    expect(codes(issqn(base, { suspension: { type: '2', processNumber: PROCESS }, municipalBenefit: { id: BM_ID } }), 'PRODUCTION')).toEqual([]);
    const exact = issqn(values(base, { discounts: { unconditional: '300.00' }, deduction: { kind: 'AMOUNT', amount: '300.00' } }), {
      municipalBenefit: { id: BM_ID, reduction: { kind: 'AMOUNT', amount: '400.00' } },
    });
    expect(codes(exact, 'HOMOLOGATION')).toEqual([]);
    const percentages = issqn(values(base, { discounts: { unconditional: '900.00' }, deduction: { kind: 'PERCENTAGE', rate: '100.00' } }), {
      municipalBenefit: { id: BM_ID, reduction: { kind: 'PERCENTAGE', rate: '100.00' } },
    });
    expect(codes(percentages, 'PRODUCTION')).toEqual([]);
  });

  it('exportação completa passa: tomador por NIF ou cNaoNIF 1/2 com endereço no exterior, intermediário no Brasil com endereço, comExt e cPaisResult', () => {
    const ok = exported({
      ...issqn(notOptant(), { taxation: '3', resultCountryCode: 'PT' }),
      taker: foreignTaker,
      intermediary: { ...intermediary(OTHER_CNPJ), address: ADDRESS },
    });
    expect(codes(ok, 'PRODUCTION')).toEqual([]);
    expect(codes(ok, 'HOMOLOGATION')).toEqual([]);
    for (const reason of ['1', '2'] as const) {
      const noNif = { ...ok, taker: { document: { type: 'NO_NIF', reason }, name: 'T', address: FOREIGN } } as const;
      expect(codes(noNif, 'HOMOLOGATION')).toEqual([]);
    }
    expect(codes(exported({ ...base, taker: foreignTaker }, { temporaryGoods: '2', importDeclaration: 'DI1' }))).toEqual([]);
    expect(codes(exported({ ...base, taker: foreignTaker }, { temporaryGoods: '3', exportRegistration: 'RE1' }))).toEqual([]);
  });

  it('prestação no exterior com comExt e cNBS passa', () => {
    const abroad = exported({ ...issqn(notOptant(), { taxation: '3' }), service: { ...base.service, municipalityCode: undefined, countryCode: 'US' } });
    expect(codes(abroad, 'PRODUCTION')).toEqual([]);
    expect(codes(abroad, 'HOMOLOGATION')).toEqual([]);
  });

  it('tomador e intermediário por NIF não servem para a retenção (E0204, E0264)', () => {
    expect(codes(exported({ ...issqn(base, { retention: '2' }), taker: foreignTaker }))).toEqual(expect.arrayContaining(['E0204', 'E0237']));
    const foreignIntermediary = { document: { type: 'NIF', value: 'X2' }, name: 'I', address: FOREIGN } as const;
    expect(codes(exported({ ...issqn(base, { retention: '3' }), intermediary: foreignIntermediary }))).toEqual(expect.arrayContaining(['E0264', 'E0293']));
  });

  it('E0428 confere só a parte que depende da DPS: o ISSQN retido, calculado pelo autorizador, não entra', () => {
    const exact = values(issqn({ ...base, taker: { ...cpfTaker, address: ADDRESS } }, { retention: '2', rate: '5.00' }), {
      discounts: { unconditional: '500.00' },
      federalTaxes: { incomeTaxWithheld: '500.00' },
    });
    expect(codes(exact)).toEqual([]);
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
      ['E0264', 'intermediary'],
      ['E0583', 'values.issqn.retention'],
      ['E0595', 'values.issqn.rate'],
      ['E0600', 'values.issqn.rate'],
    ]);
  });

  it('E0238, E0294 e E0302: código de município fora da tabela do IBGE (ADR-0058); 0000000 ("Águas Marítimas") vale no local da prestação', () => {
    const known = new Set(['2211001', '3550308']);
    const withTable = (d: DpsData, environment: RuleEnvironment = 'HOMOLOGATION') =>
      checkDpsRules(d, { ...ctx(environment), municipalityExists: (code) => known.has(code) }).map((v) => v.code);
    const takerAt = (municipalityCode: string): DpsData => ({ ...base, taker: { ...cpfTaker, address: { ...ADDRESS, municipalityCode } } });
    const intermAt = (municipalityCode: string): DpsData => ({ ...base, intermediary: { ...intermediary(OTHER_CNPJ), address: { ...ADDRESS, municipalityCode } } });

    for (const environment of ['PRODUCTION', 'HOMOLOGATION'] as const) {
      expect(withTable(base, environment)).toEqual([]);
      expect(withTable(takerAt('9999999'), environment)).toEqual(['E0238']);
      expect(withTable(intermAt('9999999'), environment)).toEqual(['E0294']);
      expect(withTable(service(base, { municipalityCode: '9999999' }), environment)).toEqual(['E0302']);
      expect(withTable(service(base, { municipalityCode: '0000000' }), environment)).toEqual([]);
    }
    expect(withTable(takerAt('3550308'))).toEqual([]);
    // Endereço no exterior e prestação no exterior não consultam a tabela.
    expect(withTable({ ...base, taker: foreignTaker })).not.toContain('E0238');
    // Sem a tabela, as três ficam com o autorizador.
    expect(codes(takerAt('9999999'))).not.toContain('E0238');
    expect(codes(service(base, { municipalityCode: '9999999' }))).not.toContain('E0302');
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
