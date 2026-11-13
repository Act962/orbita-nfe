import { describe, expect, it } from 'vitest';
import type { DpsData } from './dps.js';
import { checkSubstitutionReason, lockedFieldChanges } from './substitution.js';

const base: DpsData = {
  competenceDate: '2026-11-10',
  provider: { simplesNacionalOption: '3', simplesNacionalRegime: '1', specialTaxRegime: '0' },
  taker: { document: { type: 'CNPJ', value: '11222333000181' }, name: 'Tomador' },
  service: { municipalityCode: '2211001', nationalTaxCode: '010101', municipalTaxCode: '001', description: 'Serviço' },
  values: { serviceAmount: '1500.00', issqn: { taxation: '1', retention: '1' }, approximateTaxes: { kind: 'NOT_INFORMED' } },
};

const option = (d: DpsData, simplesNacionalOption: '1' | '2' | '3'): DpsData => ({ ...d, provider: { simplesNacionalOption, specialTaxRegime: '0' } });

/** Muda todos os campos que alguma regra trava. */
const everything = (d: DpsData): DpsData => ({
  ...d,
  competenceDate: '2026-11-11',
  taker: { document: { type: 'CPF', value: '12345678909' }, name: 'Outro' },
  service: { ...d.service, municipalityCode: '2211100', nationalTaxCode: '010201', municipalTaxCode: '002' },
  values: { ...d.values, serviceAmount: '1600.00' },
});

describe('motivo da substituição (E0078)', () => {
  it('99 sem texto é recusado; com texto, ou outro código sem texto, passa', () => {
    expect(checkSubstitutionReason({ code: '99', text: null })).toEqual({ ok: false, error: 'SUBSTITUTION_REASON_TEXT_REQUIRED' });
    expect(checkSubstitutionReason({ code: '99', text: 'Correção da descrição' }).ok).toBe(true);
    expect(checkSubstitutionReason({ code: '01', text: null }).ok).toBe(true);
  });
});

describe('campos travados na substituta (Anexo I: E0060/E0061 na produção, E0059 a E0064 na produção restrita)', () => {
  const MEI_OR_MEEPP = ['competenceDate', 'taker.document', 'values.serviceAmount'];
  const NOT_OPTANT = ['competenceDate', 'service.nationalTaxCode', 'service.municipalTaxCode', 'service.municipalityCode'];

  it.each([
    ['1', '1', 'E0059', 'E0060', NOT_OPTANT],
    ['1', '2', 'E0060', 'E0061', MEI_OR_MEEPP],
    ['1', '3', 'E0060', 'E0061', MEI_OR_MEEPP],
    ['2', '2', 'E0061', 'E0061', MEI_OR_MEEPP],
    ['2', '3', 'E0061', 'E0061', MEI_OR_MEEPP],
    // E0062: o texto da regra não lista o cTribMun (a mensagem lista); na dúvida, trava a menos.
    ['2', '1', 'E0062', 'E0060', ['competenceDate', 'service.nationalTaxCode', 'service.municipalityCode']],
    ['3', '3', 'E0063', 'E0061', MEI_OR_MEEPP],
    ['3', '2', 'E0063', 'E0061', MEI_OR_MEEPP],
    ['3', '1', 'E0064', 'E0060', NOT_OPTANT],
  ] as const)('opção %s → %s: %s (produção restrita) / %s (produção)', (from, to, homologation, production, fields) => {
    const original = option(base, from);
    const replacement = option(everything(base), to);
    expect(lockedFieldChanges(original, replacement, 'HOMOLOGATION')).toEqual(fields.map((field) => ({ rule: homologation, field })));
    expect(lockedFieldChanges(original, replacement, 'PRODUCTION')).toEqual(fields.map((field) => ({ rule: production, field })));
  });

  it('tirar o tomador identificado na original é mudança; sem tomador na original, a substituta pode trazê-lo', () => {
    expect(lockedFieldChanges(base, { ...base, taker: undefined }, 'HOMOLOGATION')).toEqual([{ rule: 'E0063', field: 'taker.document' }]);
    expect(lockedFieldChanges({ ...base, taker: undefined }, base, 'HOMOLOGATION')).toEqual([]);
  });

  it('nome, descrição, tributação e o mesmo valor escrito de outro jeito não são mudança travada', () => {
    const replacement: DpsData = {
      ...base,
      taker: { document: { type: 'CNPJ', value: '11222333000181' }, name: 'Nome corrigido' },
      service: { ...base.service, description: 'Descrição corrigida', nationalTaxCode: '010201' },
      values: { ...base.values, serviceAmount: '1500', issqn: { taxation: '1', retention: '2' } },
    };
    expect(lockedFieldChanges(base, replacement, 'HOMOLOGATION')).toEqual([]);
    expect(lockedFieldChanges(base, replacement, 'PRODUCTION')).toEqual([]);
  });
});
