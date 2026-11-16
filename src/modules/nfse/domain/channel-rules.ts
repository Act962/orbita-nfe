import type { DpsData } from './dps.js';
import type { DpsRuleViolation } from './dps-rules.js';

/**
 * Regras próprias de um canal, além do Anexo I (catálogo: docs/fiscal/regras/NFSE-TERESINA-DSF.md).
 *
 * THE-001 — emissor municipal de Teresina (DSF): `cTribMun` é obrigatório. Fonte: orientação do
 * portal da NFS-e de Teresina, aba "Documentação da API", consultada em 2026-11-10, com o código
 * obtido na tabela cTribNac × CNAE do portal (diagnóstico §1.5, CONFIRMADO). O código é do
 * contribuinte: o motor só confere a presença.
 */
export function checkChannelRules(channel: string, dps: DpsData): readonly DpsRuleViolation[] {
  if (channel === 'MUNICIPAL_TERESINA_DSF' && dps.service.municipalTaxCode === undefined) {
    return [
      {
        code: 'THE-001',
        field: 'service.municipalTaxCode',
        message: 'No emissor municipal de Teresina, o código de tributação municipal (cTribMun) é obrigatório (tabela cTribNac × CNAE do portal da NFS-e de Teresina).',
      },
    ];
  }
  return [];
}

/**
 * THE-002 — emissor municipal de Teresina (DSF): a série da DPS enviada por API deve estar entre
 * 10001 e 49999; as séries de 00001 a 10000 são do sistema municipal. Fonte: rejeição `L0022` da
 * própria homologação da DSF ao primeiro envio do motor (2026-11-16, ADR-0039), com este texto:
 * "A série informada na DPS deve estar dentro da faixa reservada para esse fim (de 10001 a 49999)".
 */
export const TERESINA_DSF_SERIES = { min: 10001, max: 49999 } as const;

export function checkChannelSeries(channel: string, series: string): DpsRuleViolation | undefined {
  if (channel !== 'MUNICIPAL_TERESINA_DSF') return undefined;
  const value = Number(series);
  if (Number.isInteger(value) && value >= TERESINA_DSF_SERIES.min && value <= TERESINA_DSF_SERIES.max) return undefined;
  return {
    code: 'THE-002',
    field: 'seriesId',
    message: `No emissor municipal de Teresina, a série da DPS deve estar entre ${TERESINA_DSF_SERIES.min} e ${TERESINA_DSF_SERIES.max} (as séries até 10000 são do sistema municipal).`,
  };
}
