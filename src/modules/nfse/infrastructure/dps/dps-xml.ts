import type { DpsData } from '../../domain/dps.js';

/**
 * Montagem determinística do XML da DPS (ADR-0014, ADR-0033) a partir do contrato v1.
 *
 * A ordem dos elementos segue a `xs:sequence` de cada tipo no XSD do pacote. Os pacotes NÃO têm
 * a mesma ordem: no de produção restrita (20/10/2026) `xDescServ` vai para o fim de `cServ` e
 * `finNFSe` passa a existir em `infDPS`. Por isso cada pacote suportado tem um perfil de leiaute;
 * pacote sem perfil não monta (falha local, nada é enviado).
 */
export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

interface LayoutProfile {
  /** `finNFSe` em infDPS (TSRTCFinNFSe; única enumeração no pacote: 0 - NFS-e regular). */
  readonly finNFSe: boolean;
  /** Ordem em TCCServ. */
  readonly serviceOrder: readonly ('cTribNac' | 'cTribMun' | 'xDescServ' | 'cNBS')[];
}

export const LAYOUT_PROFILES: Readonly<Record<string, LayoutProfile>> = {
  'nfse-nacional/1.01-20260209': { finNFSe: false, serviceOrder: ['cTribNac', 'cTribMun', 'xDescServ', 'cNBS'] },
  'nfse-nacional/1.01-20261020-prodrest': { finNFSe: true, serviceOrder: ['cTribNac', 'cTribMun', 'cNBS', 'xDescServ'] },
};

export interface DpsXmlInput {
  readonly layoutPackage: string;
  readonly dpsId: string;
  readonly tpAmb: '1' | '2';
  /** dhEmi já formatado (TSDateTimeUTC). */
  readonly dhEmi: string;
  readonly verAplic: string;
  readonly series: string;
  readonly number: number;
  readonly issuerMunicipalityCode: string;
  readonly issuerCnpj: string;
  readonly dps: DpsData;
  /** Grupo `subst` (TCSubstituicao), só na nota substituta (ADR-0036). */
  readonly substitution?: { readonly accessKey: string; readonly reasonCode: string; readonly reasonText: string | null } | undefined;
}

export class LayoutNotSupportedError extends Error {
  constructor(readonly layoutPackage: string) {
    super(`LAYOUT_NOT_SUPPORTED: ${layoutPackage}`);
    this.name = 'LayoutNotSupportedError';
  }
}

export function buildDpsXml(input: DpsXmlInput): string {
  const layout = LAYOUT_PROFILES[input.layoutPackage];
  if (layout === undefined) throw new LayoutNotSupportedError(input.layoutPackage);
  const { dps } = input;

  const prest =
    el('CNPJ', input.issuerCnpj) +
    opt('IM', dps.provider.municipalRegistration) +
    group('regTrib', el('opSimpNac', dps.provider.simplesNacionalOption) + opt('regApTribSN', dps.provider.simplesNacionalRegime) + el('regEspTrib', dps.provider.specialTaxRegime));

  const toma =
    dps.taker === undefined
      ? ''
      : group('toma', el(dps.taker.document.type, dps.taker.document.value) + opt('IM', dps.taker.municipalRegistration) + el('xNome', dps.taker.name) + opt('email', dps.taker.email));

  const serviceParts: Record<LayoutProfile['serviceOrder'][number], string> = {
    cTribNac: el('cTribNac', dps.service.nationalTaxCode),
    cTribMun: opt('cTribMun', dps.service.municipalTaxCode),
    xDescServ: el('xDescServ', dps.service.description),
    cNBS: opt('cNBS', dps.service.nbsCode),
  };
  const serv = group('serv', group('locPrest', el('cLocPrestacao', dps.service.municipalityCode)) + group('cServ', layout.serviceOrder.map((k) => serviceParts[k]).join('')));

  const issqn = dps.values.issqn;
  const tribMun = group('tribMun', el('tribISSQN', issqn.taxation) + el('tpRetISSQN', issqn.retention) + opt('pAliq', issqn.rate));
  const taxes = dps.values.approximateTaxes;
  const totTrib = group(
    'totTrib',
    taxes.kind === 'AMOUNTS'
      ? group('vTotTrib', el('vTotTribFed', taxes.federal) + el('vTotTribEst', taxes.state) + el('vTotTribMun', taxes.municipal))
      : taxes.kind === 'PERCENTAGES'
        ? group('pTotTrib', el('pTotTribFed', taxes.federal) + el('pTotTribEst', taxes.state) + el('pTotTribMun', taxes.municipal))
        : taxes.kind === 'SIMPLES_NACIONAL_RATE'
          ? el('pTotTribSN', taxes.rate)
          : el('indTotTrib', '0'),
  );
  const valores = group('valores', group('vServPrest', el('vServ', dps.values.serviceAmount)) + group('trib', tribMun + totTrib));

  const inf =
    el('tpAmb', input.tpAmb) +
    el('dhEmi', input.dhEmi) +
    el('verAplic', input.verAplic) +
    el('serie', input.series) +
    el('nDPS', String(input.number)) +
    el('dCompet', dps.competenceDate) +
    el('tpEmit', '1') + // 1 - Prestador: o motor emite em nome do prestador (estabelecimento).
    (layout.finNFSe ? el('finNFSe', '0') : '') +
    el('cLocEmi', input.issuerMunicipalityCode) +
    // Mesma posição nos dois pacotes: depois de cLocEmi, antes de prest.
    (input.substitution === undefined
      ? ''
      : group('subst', el('chSubstda', input.substitution.accessKey) + el('cMotivo', input.substitution.reasonCode) + opt('xMotivo', input.substitution.reasonText ?? undefined))) +
    group('prest', prest) +
    toma +
    serv +
    valores;

  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NFSE_NS}" versao="1.01"><infDPS Id="${attr(input.dpsId)}">${inf}</infDPS></DPS>`;
}

/** Elemento folha: o valor é SEMPRE escapado (nunca vira marcação). */
export function el(name: string, value: string): string {
  return `<${name}>${text(value)}</${name}>`;
}

/** Grupo: o conteúdo já foi montado por el()/group(). */
export function group(name: string, content: string): string {
  return `<${name}>${content}</${name}>`;
}

function opt(name: string, value: string | undefined): string {
  return value === undefined ? '' : el(name, value);
}

/** Escapa texto de elemento. */
function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function attr(value: string): string {
  return text(value).replace(/"/g, '&quot;');
}
