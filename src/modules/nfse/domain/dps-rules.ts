import { Cnpj } from '../../../shared/domain/cnpj.js';
import type { DpsData } from './dps.js';

/**
 * Regras do Anexo I (aba RN DPS_NFS-e) conferidas antes de numerar (L3, doc 14 §A1).
 * Catálogo com a fonte de cada uma: docs/fiscal/regras/NFSE-DPS.md (ADR-0037).
 *
 * Entram só regras de nível 1 ou 2 que dependem APENAS de dados da DPS do contrato v1, com texto
 * claro no Anexo do ambiente. Regras que dependem de cadastro (CNPJ, CNC, Simples), da
 * parametrização do município ou de tabelas que o motor não tem ficam com o autorizador.
 *
 * Fontes: Anexo I v1.01 de produção (09/02/2026, SHA-256 de5bc492…eeb7c) e de produção restrita
 * (20/10/2026, SHA-256 72b05981…2dd8). Quando o texto muda entre os dois, cada ambiente segue o seu.
 */
export const DPS_RULE_SET_VERSION = 'anexo-i-v1.01-20260209+20261020';

export type RuleEnvironment = 'PRODUCTION' | 'HOMOLOGATION';

export interface DpsRuleContext {
  readonly environment: RuleEnvironment;
  /** CNPJ do prestador (o estabelecimento emitente). */
  readonly providerCnpj: string;
  /** Data de emissão (dhEmi) que a DPS terá, AAAA-MM-DD em UTC−03:00 (ADR-0033 item 4). */
  readonly issueDate: string;
}

export interface DpsRuleViolation {
  /** Código de rejeição do Anexo I. */
  readonly code: string;
  /** Caminho no contrato v1. */
  readonly field: string;
  readonly message: string;
}

const BOTH: readonly RuleEnvironment[] = ['PRODUCTION', 'HOMOLOGATION'];
const PRODUCTION_ONLY: readonly RuleEnvironment[] = ['PRODUCTION'];
const HOMOLOGATION_ONLY: readonly RuleEnvironment[] = ['HOMOLOGATION'];

interface DpsRule {
  readonly code: string;
  readonly environments: readonly RuleEnvironment[];
  readonly field: string;
  readonly message: string;
  /** Verdadeiro quando a DPS VIOLA a regra. */
  readonly violated: (dps: DpsData, context: DpsRuleContext) => boolean;
}

/** Sem endereço nem intermediário no contrato v1: a regra não tem como ser cumprida ainda. */
const NEEDS_V2 = 'O contrato v1 ainda não leva este grupo da DPS; a emissão neste caso depende do contrato v2.';

const notTaxable = (d: DpsData) => d.values.issqn.taxation !== '1'; // 2 Imunidade, 3 Exportação, 4 Não incidência
const option = (d: DpsData) => d.provider.simplesNacionalOption;
const specialRegime = (d: DpsData) => d.provider.specialTaxRegime !== '0';
const retained = (d: DpsData) => d.values.issqn.retention !== '1';

export const DPS_RULES: readonly DpsRule[] = [
  // ------------------------------------------------------------------ datas
  {
    code: 'E0015',
    environments: BOTH,
    field: 'competenceDate',
    message: 'A data de competência deve ser anterior ou igual à data de emissão da DPS (hoje, horário de Brasília).',
    violated: (d, c) => d.competenceDate > c.issueDate,
  },
  // ------------------------------------------------------------------ regime do prestador
  {
    code: 'E0162',
    environments: BOTH,
    field: 'provider.simplesNacionalRegime',
    message: 'O regime de apuração do Simples (regApTribSN) não pode ser informado para não optante ou MEI.',
    violated: (d) => option(d) !== '3' && d.provider.simplesNacionalRegime !== undefined,
  },
  {
    code: 'E0166',
    environments: BOTH,
    field: 'provider.simplesNacionalRegime',
    message: 'O regime de apuração do Simples (regApTribSN) é obrigatório para ME/EPP (opSimpNac = 3).',
    violated: (d) => option(d) === '3' && d.provider.simplesNacionalRegime === undefined,
  },
  {
    code: 'E0172',
    environments: BOTH,
    field: 'provider.specialTaxRegime',
    message: 'Com imunidade, exportação ou não incidência (tribISSQN 2, 3 ou 4), o regime especial de tributação deve ser 0 (Nenhum).',
    violated: (d) => notTaxable(d) && specialRegime(d),
  },
  {
    code: 'E0174',
    environments: BOTH,
    field: 'provider.specialTaxRegime',
    message: 'Para MEI (opSimpNac = 2), o regime especial de tributação deve ser 0 (Nenhum).',
    violated: (d) => option(d) === '2' && specialRegime(d),
  },
  {
    code: 'E0175',
    environments: BOTH,
    field: 'provider.specialTaxRegime',
    message: 'Para ME/EPP com apuração pelo Simples (opSimpNac = 3 e regApTribSN = 1), o regime especial de tributação deve ser 0 (Nenhum).',
    violated: (d) => option(d) === '3' && d.provider.simplesNacionalRegime === '1' && specialRegime(d),
  },
  // ------------------------------------------------------------------ tomador
  {
    code: 'E0188',
    environments: BOTH,
    field: 'taker.document',
    message: 'O CNPJ do tomador é inválido (dígitos verificadores).',
    violated: (d) => d.taker?.document.type === 'CNPJ' && !Cnpj.parse(d.taker.document.value).ok,
  },
  {
    code: 'E0202',
    environments: BOTH,
    field: 'taker.document',
    message: 'O CNPJ do tomador é igual ao CNPJ do prestador.',
    violated: (d, c) => d.taker?.document.type === 'CNPJ' && d.taker.document.value === c.providerCnpj,
  },
  {
    code: 'E0204',
    environments: BOTH,
    field: 'taker',
    message: 'Com retenção pelo tomador (tpRetISSQN = 2), o tomador deve ser identificado por CNPJ ou CPF.',
    violated: (d) => d.values.issqn.retention === '2' && d.taker === undefined,
  },
  {
    code: 'E0235',
    environments: BOTH,
    field: 'taker',
    message: `Tomador identificado por CNPJ exige o endereço nacional do tomador (toma/end/endNac). ${NEEDS_V2}`,
    violated: (d) => d.taker?.document.type === 'CNPJ',
  },
  {
    code: 'E0237',
    environments: BOTH,
    field: 'values.issqn.retention',
    message: `Com retenção pelo tomador (tpRetISSQN = 2), o endereço nacional do tomador é obrigatório. ${NEEDS_V2}`,
    violated: (d) => d.values.issqn.retention === '2',
  },
  {
    code: 'E0264',
    environments: BOTH,
    field: 'values.issqn.retention',
    message: `Com retenção pelo intermediário (tpRetISSQN = 3), o intermediário deve ser identificado. ${NEEDS_V2}`,
    violated: (d) => d.values.issqn.retention === '3',
  },
  // ------------------------------------------------------------------ serviço
  {
    code: 'E1402',
    environments: BOTH,
    field: 'service.municipalityCode',
    message: 'Com o código de tributação nacional 200101, o local da prestação não pode ser 0000000 (Águas Marítimas).',
    violated: (d) => d.service.nationalTaxCode === '200101' && d.service.municipalityCode === '0000000',
  },
  {
    code: 'E0309',
    environments: HOMOLOGATION_ONLY,
    field: 'service.nationalTaxCode',
    message: 'Os códigos de tributação nacional 99.03.xx e 99.04.01 não são aceitos.',
    violated: (d) => /^9903[0-9]{2}$/.test(d.service.nationalTaxCode) || d.service.nationalTaxCode === '990401',
  },
  {
    code: 'E0313',
    environments: HOMOLOGATION_ONLY,
    field: 'service.municipalTaxCode',
    message: 'O código de tributação municipal não pode ser informado para MEI.',
    violated: (d) => option(d) === '2' && d.service.municipalTaxCode !== undefined,
  },
  {
    code: 'E0315',
    environments: BOTH,
    field: 'service.municipalTaxCode',
    message: 'O código de tributação municipal não pode ser 000.',
    violated: (d) => d.service.municipalTaxCode === '000',
  },
  {
    code: 'E0532',
    environments: PRODUCTION_ONLY,
    field: 'values.issqn.taxation',
    message: 'Para o serviço 99.01.01 (sem incidência de ISSQN e ICMS), a tributação do ISSQN deve ser 4 (Não incidência).',
    violated: (d) => d.service.nationalTaxCode === '990101' && d.values.issqn.taxation !== '4',
  },
  {
    code: 'E0532',
    environments: HOMOLOGATION_ONLY,
    field: 'values.issqn.taxation',
    message: 'Para os serviços 99.XX.XX (sem incidência de ISSQN e ICMS), a tributação do ISSQN deve ser 4 (Não incidência).',
    violated: (d) => d.service.nationalTaxCode.startsWith('99') && d.values.issqn.taxation !== '4',
  },
  // ------------------------------------------------------------------ ISSQN
  {
    code: 'E0592',
    environments: PRODUCTION_ONLY,
    field: 'values.issqn.taxation',
    message: `Com imunidade (tribISSQN = 2), o tipo de imunidade (tpImunidade) é obrigatório. ${NEEDS_V2}`,
    violated: (d) => d.values.issqn.taxation === '2',
  },
  {
    code: 'E0580',
    environments: BOTH,
    field: 'values.issqn.retention',
    message: 'Com imunidade, exportação ou não incidência (tribISSQN 2, 3 ou 4), não há retenção do ISSQN (tpRetISSQN = 1).',
    violated: (d) => notTaxable(d) && retained(d),
  },
  {
    code: 'E0583',
    environments: BOTH,
    field: 'values.issqn.retention',
    message: 'Para MEI (opSimpNac = 2), não há retenção do ISSQN (tpRetISSQN = 1).',
    violated: (d) => option(d) === '2' && retained(d),
  },
  {
    code: 'E0588',
    environments: BOTH,
    field: 'values.issqn.retention',
    message: 'Com regime especial de tributação (regEspTrib diferente de 0), não há retenção do ISSQN (tpRetISSQN = 1).',
    violated: (d) => specialRegime(d) && retained(d),
  },
  {
    code: 'E0596',
    environments: PRODUCTION_ONLY,
    field: 'values.issqn.retention',
    message: 'Para o serviço 22.01.01, não há retenção do ISSQN (tpRetISSQN = 1).',
    violated: (d) => d.service.nationalTaxCode === '220101' && retained(d),
  },
  {
    code: 'E0595',
    environments: BOTH,
    field: 'values.issqn.rate',
    message: 'A alíquota do ISSQN (pAliq) não pode ser superior a 5%.',
    violated: (d) => d.values.issqn.rate !== undefined && hundredths(d.values.issqn.rate) > 500n,
  },
  {
    code: 'E0600',
    environments: BOTH,
    field: 'values.issqn.rate',
    message: 'Para MEI (opSimpNac = 2), a alíquota do ISSQN (pAliq) não pode ser informada.',
    violated: (d) => option(d) === '2' && d.values.issqn.rate !== undefined,
  },
  {
    code: 'E0602',
    environments: BOTH,
    field: 'values.issqn.rate',
    message: 'Com imunidade, exportação ou não incidência (tribISSQN 2, 3 ou 4), a alíquota do ISSQN (pAliq) não pode ser informada.',
    violated: (d) => notTaxable(d) && d.values.issqn.rate !== undefined,
  },
  {
    code: 'E0604',
    environments: BOTH,
    field: 'values.issqn.rate',
    message: 'Com regime especial de tributação (regEspTrib diferente de 0), a alíquota do ISSQN (pAliq) não pode ser informada.',
    violated: (d) => specialRegime(d) && d.values.issqn.rate !== undefined,
  },
  // ------------------------------------------------------------------ totais aproximados (Lei 12.741/2012)
  ...(['federal', 'state', 'municipal'] as const).map(
    (part, i): DpsRule => ({
      code: ['E0702', 'E0703', 'E0704'][i] ?? '',
      environments: BOTH,
      field: `values.approximateTaxes.${part}`,
      message: 'O valor aproximado dos tributos não pode ser maior que o valor do serviço.',
      violated: (d) => d.values.approximateTaxes.kind === 'AMOUNTS' && hundredths(d.values.approximateTaxes[part]) > hundredths(d.values.serviceAmount),
    }),
  ),
  ...(['federal', 'state', 'municipal'] as const).map(
    (part, i): DpsRule => ({
      code: ['E0706', 'E0707', 'E0708'][i] ?? '',
      environments: BOTH,
      field: `values.approximateTaxes.${part}`,
      message: 'O percentual aproximado dos tributos não pode ser maior que 100%.',
      violated: (d) => d.values.approximateTaxes.kind === 'PERCENTAGES' && hundredths(d.values.approximateTaxes[part]) > 10_000n,
    }),
  ),
  {
    code: 'E0710',
    environments: BOTH,
    field: 'values.approximateTaxes',
    message: 'Para MEI, o percentual do Simples Nacional (pTotTribSN) não pode ser informado.',
    violated: (d) => option(d) === '2' && d.values.approximateTaxes.kind === 'SIMPLES_NACIONAL_RATE',
  },
  {
    code: 'E0712',
    environments: BOTH,
    field: 'values.approximateTaxes',
    message: 'Para ME/EPP, "não informar" os tributos aproximados (indTotTrib) não é permitido.',
    violated: (d) => option(d) === '3' && d.values.approximateTaxes.kind === 'NOT_INFORMED',
  },
  {
    code: 'E0713',
    environments: BOTH,
    field: 'values.approximateTaxes',
    message: 'Para não optante, nem indTotTrib nem pTotTribSN podem ser informados.',
    violated: (d) => option(d) === '1' && (d.values.approximateTaxes.kind === 'NOT_INFORMED' || d.values.approximateTaxes.kind === 'SIMPLES_NACIONAL_RATE'),
  },
];

/** Todas as violações de uma vez (doc 14 §A1), na ordem do catálogo. */
export function checkDpsRules(dps: DpsData, context: DpsRuleContext): readonly DpsRuleViolation[] {
  return DPS_RULES.filter((rule) => rule.environments.includes(context.environment) && rule.violated(dps, context)).map((rule) => ({
    code: rule.code,
    field: rule.field,
    message: rule.message,
  }));
}

/** Decimal do XSD (TSDec…V2, até 2 casas) em centésimos, sem ponto flutuante. */
export function hundredths(value: string): bigint {
  const [units = '0', fraction = ''] = value.split('.');
  return BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}
