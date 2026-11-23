import { isForeignAddress, type DpsData, type ForeignTrade, type Party, type PartyAddress } from '../../domain/dps.js';

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
  /**
   * Grupo de dedução/redução da base do ISSQN em TCInfoValores, logo depois de vDescCondIncond
   * (ADR-0042): `vDedRed` (choice pDR | vDR | documentos) ou `vAjusteBC` (choice opcional
   * pAjusteBCISSQN | vAjusteBCISSQN, seguida de documentos?).
   */
  readonly deduction: { readonly group: string; readonly percentage: string; readonly amount: string };
}

export const LAYOUT_PROFILES: Readonly<Record<string, LayoutProfile>> = {
  'nfse-nacional/1.01-20260209': {
    finNFSe: false,
    serviceOrder: ['cTribNac', 'cTribMun', 'xDescServ', 'cNBS'],
    deduction: { group: 'vDedRed', percentage: 'pDR', amount: 'vDR' },
  },
  'nfse-nacional/1.01-20261020-prodrest': {
    finNFSe: true,
    serviceOrder: ['cTribNac', 'cTribMun', 'cNBS', 'xDescServ'],
    deduction: { group: 'vAjusteBC', percentage: 'pAjusteBCISSQN', amount: 'vAjusteBCISSQN' },
  },
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

  const toma = dps.taker === undefined ? '' : group('toma', party(dps.taker));
  const interm = dps.intermediary === undefined ? '' : group('interm', party(dps.intermediary));

  const serviceParts: Record<LayoutProfile['serviceOrder'][number], string> = {
    cTribNac: el('cTribNac', dps.service.nationalTaxCode),
    cTribMun: opt('cTribMun', dps.service.municipalTaxCode),
    xDescServ: el('xDescServ', dps.service.description),
    cNBS: opt('cNBS', dps.service.nbsCode),
  };
  // TCLocPrest: choice cLocPrestacao | cPaisPrestacao (ADR-0045); o aceite garante exatamente um.
  const locPrest =
    dps.service.countryCode === undefined ? el('cLocPrestacao', dps.service.municipalityCode ?? '') : el('cPaisPrestacao', dps.service.countryCode);
  const serv = group('serv', group('locPrest', locPrest) +group('cServ', layout.serviceOrder.map((k) => serviceParts[k]).join('')) +
      // TCServ: locPrest, cServ, comExt?, ... (ADR-0044).
      (dps.service.foreignTrade === undefined ? '' : foreignTrade(dps.service.foreignTrade)),
  );

  const issqn = dps.values.issqn;
  // Ordem de TCTribMunicipal: tribISSQN, cPaisResult?, tpImunidade?, exigSusp?, BM?, tpRetISSQN, pAliq?.
  // Iguais nos dois pacotes (ADR-0043, ADR-0044).
  const exigSusp = issqn.suspension === undefined ? '' : group('exigSusp', el('tpSusp', issqn.suspension.type) + el('nProcesso', issqn.suspension.processNumber));
  const bm = issqn.municipalBenefit;
  const bmGroup =
    bm === undefined
      ? ''
      : group(
          'BM',
          el('nBM', bm.id) +
            (bm.reduction === undefined ? '' : bm.reduction.kind === 'AMOUNT' ? el('vRedBCBM', bm.reduction.amount) : el('pRedBCBM', bm.reduction.rate)),
        );
  const tribMun = group(
    'tribMun',
    el('tribISSQN', issqn.taxation) + opt('cPaisResult', issqn.resultCountryCode) + opt('tpImunidade', issqn.immunityType) + exigSusp + bmGroup + el('tpRetISSQN', issqn.retention) + opt('pAliq', issqn.rate),
  );
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
  // TCInfoValores: vServPrest, vDescCondIncond?, vDedRed? | vAjusteBC? (conforme o pacote), trib.
  // TCInfoTributacao: tribMun, tribFed?, totTrib. Iguais nos dois pacotes nestes grupos (ADR-0041).
  const discounts = dps.values.discounts;
  const vDescCondIncond = discounts === undefined ? '' : group('vDescCondIncond', opt('vDescIncond', discounts.unconditional) + opt('vDescCond', discounts.conditional));
  const ded = dps.values.deduction;
  const deduction =
    ded === undefined
      ? ''
      : group(layout.deduction.group, ded.kind === 'PERCENTAGE' ? el(layout.deduction.percentage, ded.rate) : el(layout.deduction.amount, ded.amount));
  const fed = dps.values.federalTaxes;
  const pc = fed?.pisCofins;
  const tribFed =
    fed === undefined
      ? ''
      : group(
          'tribFed',
          (pc === undefined
            ? ''
            : group(
                'piscofins',
                el('CST', pc.cst) +
                  opt('vBCPisCofins', pc.baseAmount) +
                  opt('pAliqPis', pc.pisRate) +
                  opt('pAliqCofins', pc.cofinsRate) +
                  opt('vPis', pc.pisAmount) +
                  opt('vCofins', pc.cofinsAmount) +
                  opt('tpRetPisCofins', pc.retentionType),
              )) +
            opt('vRetCP', fed.socialSecurityWithheld) +
            opt('vRetIRRF', fed.incomeTaxWithheld) +
            opt('vRetCSLL', fed.contributionsWithheld),
        );
  const valores = group('valores', group('vServPrest', el('vServ', dps.values.serviceAmount)) + vDescCondIncond + deduction + group('trib', tribMun + tribFed + totTrib));

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
    interm +
    serv +
    valores;

  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NFSE_NS}" versao="1.01"><infDPS Id="${attr(input.dpsId)}">${inf}</infDPS></DPS>`;
}

/**
 * TCInfoPessoa, na ordem do XSD: CNPJ|CPF, CAEPF?, IM?, xNome, end?, fone?, email?. Igual nos dois
 * pacotes (o de produção restrita só torna o xNome opcional; o contrato sempre o exige).
 */
function party(p: Party): string {
  const id = p.document.type === 'NO_NIF' ? el('cNaoNIF', p.document.reason) : el(p.document.type, p.document.value);
  return id + opt('IM', p.municipalRegistration) + el('xNome', p.name) + (p.address === undefined ? '' : address(p.address)) + opt('fone', p.phone) + opt('email', p.email);
}

/**
 * TCEndereco: choice endNac(cMun, CEP) | endExt(cPais, cEndPost, xCidade, xEstProvReg), seguida de
 * xLgr, nro, xCpl?, xBairro. Igual nos dois pacotes.
 */
function address(a: PartyAddress): string {
  const where = isForeignAddress(a)
    ? group('endExt', el('cPais', a.countryCode) + el('cEndPost', a.postalCode) + el('xCidade', a.city) + el('xEstProvReg', a.region))
    : group('endNac', el('cMun', a.municipalityCode) + el('CEP', a.postalCode));
  return group('end', where + el('xLgr', a.street) + el('nro', a.number) + opt('xCpl', a.complement) + el('xBairro', a.district));
}

/** TCComExterior (ADR-0044), na ordem do XSD; igual nos dois pacotes. */
function foreignTrade(f: ForeignTrade): string {
  return group(
    'comExt',
    el('mdPrestacao', f.mode) +
      el('vincPrest', f.relationship) +
      el('tpMoeda', f.currencyCode) +
      el('vServMoeda', f.amountInCurrency) +
      el('mecAFComexP', f.providerSupport) +
      el('mecAFComexT', f.takerSupport) +
      el('movTempBens', f.temporaryGoods) +
      opt('nDI', f.importDeclaration) +
      opt('nRE', f.exportRegistration) +
      el('mdic', f.shareWithMdic ? '1' : '0'),
  );
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
