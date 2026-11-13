import { err, ok, type Result } from '../../../shared/domain/result.js';
import type { DpsData } from './dps.js';

/**
 * Substituição de NFS-e (ADR-0036). A substituta é uma DPS nova com o grupo `subst`
 * (TCSubstituicao): `chSubstda` (chave da nota substituída), `cMotivo` e `xMotivo`. O autorizador
 * gera sozinho o evento e105102 ("Cancelamento de NFS-e por Substituição") na nota original.
 *
 * Fontes: XSD v1.01 (tiposComplexos TCSubstituicao, tiposSimples TSCodJustSubst e TSMotivo) dos
 * dois pacotes, idênticos neste ponto; Anexo I v1.01 de 09/02/2026, aba RN DPS_NFS-e (E0042 a
 * E0078) e Anexo I de produção restrita de 20/10/2026 (E0059 a E0064). Só regras de nível 1 e 2
 * com mapeamento direto para o contrato v1 viram pré-validação; o resto (prazo do município,
 * eventos de terceiros) é do autorizador.
 */

/**
 * TSCodJustSubst (enumeração do XSD; o leiaute do Anexo I de produção escreve "1 - ...", o de
 * produção restrita já escreve "01 - ..."; quem valida é o XSD): 01 Desenquadramento do Simples Nacional; 02 Enquadramento no Simples Nacional;
 * 03 Inclusão retroativa de imunidade/isenção; 04 Exclusão retroativa de imunidade/isenção;
 * 05 Rejeição pelo tomador ou pelo intermediário responsável pelo recolhimento; 99 Outros.
 * Escolha do contribuinte: o motor não escolhe nem sugere.
 */
export const SUBSTITUTION_REASON_CODES = ['01', '02', '03', '04', '05', '99'] as const;
export type SubstitutionReasonCode = (typeof SUBSTITUTION_REASON_CODES)[number];

/** Motivo como gravado na substituta (o `xMotivo` é opcional no XSD). */
export interface SubstitutionReason {
  readonly code: SubstitutionReasonCode;
  readonly text: string | null;
}

/** E0078 (nível 1): com `cMotivo` = 99, o `xMotivo` é obrigatório. */
export function checkSubstitutionReason(reason: SubstitutionReason): Result<SubstitutionReason, 'SUBSTITUTION_REASON_TEXT_REQUIRED'> {
  return reason.code === '99' && reason.text === null ? err('SUBSTITUTION_REASON_TEXT_REQUIRED') : ok(reason);
}

/** Campo do contrato v1 que a substituta não pode mudar. */
export type LockedField =
  | 'competenceDate'
  | 'taker.document'
  | 'values.serviceAmount'
  | 'service.nationalTaxCode'
  | 'service.municipalTaxCode'
  | 'service.municipalityCode';

/** Campo que a substituta mudou, com a regra (código do Anexo I do pacote do ambiente). */
export interface LockedFieldChange {
  readonly rule: string;
  readonly field: LockedField;
}

type SimplesOption = DpsData['provider']['simplesNacionalOption'];

/**
 * Códigos por par (opção da original → opção da substituta).
 *
 * - Produção restrita, Anexo I de 20/10/2026: matriz explícita, E0059 a E0064.
 * - Produção, Anexo I de 09/02/2026: E0060 (não optante) e E0061 (MEI ou ME/EPP), sem dizer de
 *   qual nota é a opção. Lida pela opção da SUBSTITUTA (a DPS validada), dá os mesmos campos da
 *   matriz nova; a matriz confirma essa leitura.
 */
const RULES: Readonly<Record<'PRODUCTION' | 'HOMOLOGATION', Readonly<Record<`${SimplesOption}>${SimplesOption}`, string>>>> = {
  HOMOLOGATION: { '1>1': 'E0059', '1>2': 'E0060', '1>3': 'E0060', '2>2': 'E0061', '2>3': 'E0061', '2>1': 'E0062', '3>3': 'E0063', '3>2': 'E0063', '3>1': 'E0064' },
  PRODUCTION: { '1>1': 'E0060', '2>1': 'E0060', '3>1': 'E0060', '1>2': 'E0061', '1>3': 'E0061', '2>2': 'E0061', '2>3': 'E0061', '3>2': 'E0061', '3>3': 'E0061' },
};

/**
 * Campos travados na substituta (nível 2 do Anexo I). Depende da opção pelo Simples da original e
 * da substituta:
 * - substituta MEI ou ME/EPP: `dCompet`, identificação do tomador (CPF/CNPJ, se identificado na
 *   DPS da nota ORIGINAL) e `vServ`;
 * - substituta não optante: `dCompet`, `cTribNac` (o "subitem da lista nacional"),
 *   `cLocPrestacao` e `cTribMun`.
 *
 * Uma exceção, a favor do cliente: na E0062 (MEI → não optante) o texto da regra não lista o
 * `cTribMun`, embora a mensagem liste. Na dúvida, o motor confere MENOS: trava a mais recusaria
 * uma substituição válida, e trava a menos só deixa a decisão para o autorizador.
 */
export function lockedFieldChanges(original: DpsData, replacement: DpsData, environment: 'PRODUCTION' | 'HOMOLOGATION'): readonly LockedFieldChange[] {
  const from = original.provider.simplesNacionalOption;
  const to = replacement.provider.simplesNacionalOption;
  const rule = RULES[environment][`${from}>${to}`];
  const changed: LockedField[] = [];
  if (replacement.competenceDate !== original.competenceDate) changed.push('competenceDate');
  if (to === '1') {
    if (replacement.service.nationalTaxCode !== original.service.nationalTaxCode) changed.push('service.nationalTaxCode');
    if (from !== '2' && replacement.service.municipalTaxCode !== original.service.municipalTaxCode) changed.push('service.municipalTaxCode');
    if (replacement.service.municipalityCode !== original.service.municipalityCode) changed.push('service.municipalityCode');
  } else {
    if (original.taker !== undefined) {
      const before = original.taker.document;
      const after = replacement.taker?.document;
      if (after?.type !== before.type || after.value !== before.value) changed.push('taker.document');
    }
    if (!sameAmount(replacement.values.serviceAmount, original.values.serviceAmount)) changed.push('values.serviceAmount');
  }
  return changed.map((field) => ({ rule, field }));
}

/** "1500" e "1500.00" são o mesmo valor (TSDec15V2 aceita as duas formas). */
function sameAmount(a: string, b: string): boolean {
  return cents(a) === cents(b);
}

function cents(value: string): bigint {
  const [units = '0', fraction = ''] = value.split('.');
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}
