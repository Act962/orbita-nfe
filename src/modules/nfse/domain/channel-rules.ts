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
