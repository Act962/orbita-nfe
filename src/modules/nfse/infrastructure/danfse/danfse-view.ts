import {
  describe,
  FIN_NFSE,
  OP_SIMP_NAC,
  REG_AP_TRIB_SN,
  REG_ESP_TRIB,
  TP_BM,
  TP_EMIT,
  TP_IMUNIDADE,
  TP_RET_ISSQN,
  TP_RET_PIS_COFINS,
  TP_SUSP,
  TRIB_ISSQN,
} from '../../domain/danfse-catalog.js';
import { nfseStatusDescription } from '../../domain/nfse-status.js';
import type { NfseDocument, NfseNode } from './nfse-document.js';

/**
 * Conteúdo do DANFSe (NT 008 SE/CGNFS-e v1.02, itens 2.1 e 2.4.5, notas 1 a 12), montado a partir
 * do XML da NFS-e. Aqui ficam o conteúdo e a formatação; as posições ficam em `danfse-pdf.ts`.
 *
 * Regras seguidas (todas da NT, item 2.4.5):
 * - campo sem informação no XML → "-" (nota 12);
 * - texto maior que o tamanho do campo → corta e termina com "..." (item 2.1);
 * - opções codificadas → a descrição do leiaute (`danfse-catalog.ts`); código desconhecido → o código;
 * - tomador, destinatário e intermediário ausentes → as frases das notas 2 e 3;
 * - a linha de PIS/COFINS de apuração própria só para competência até 31/12/2026 (nota 6);
 * - a linha de totais aproximados dos tributos é obrigatória (nota 10).
 */
export const DASH = '-';

export type MunicipalityLookup = (code: string) => { readonly name: string; readonly uf: string } | undefined;

export interface DanfseParty {
  readonly document: string;
  readonly municipalRegistration: string;
  readonly phone: string;
  readonly name: string;
  readonly municipality: string;
  readonly ibgeAndPostalCode: string;
  readonly address: string;
  readonly email: string;
}

/** Bloco de pessoa: os campos, ou só a frase da nota 2/3 quando o bloco não se aplica. */
export type DanfsePartyBlock = { readonly kind: 'PARTY'; readonly party: DanfseParty } | { readonly kind: 'MESSAGE'; readonly message: string };

export interface DanfseView {
  readonly homologation: boolean;
  readonly watermark: 'CANCELADA' | 'SUBSTITUÍDA' | null;
  readonly header: { readonly municipality: string | null; readonly generator: string; readonly environment: string };
  readonly identification: {
    readonly accessKey: string;
    readonly number: string;
    readonly competence: string;
    readonly issuedAt: string;
    readonly dpsNumber: string;
    readonly dpsSeries: string;
    readonly dpsIssuedAt: string;
    readonly emitter: string;
    readonly status: string;
    readonly purpose: string;
  };
  readonly qrCodeUrl: string;
  readonly provider: DanfseParty & { readonly simplesNacional: string; readonly simplesNacionalRegime: string };
  readonly taker: DanfsePartyBlock;
  readonly recipient: DanfsePartyBlock;
  readonly intermediary: DanfsePartyBlock;
  readonly service: { readonly taxCode: string; readonly nbs: string; readonly place: string; readonly taxCodeDescription: string; readonly description: string };
  readonly municipalTax: {
    readonly taxation: string;
    readonly incidence: string;
    readonly specialRegime: string;
    readonly immunity: string;
    readonly suspension: string;
    readonly suspensionProcess: string;
    readonly benefit: string;
    readonly benefitCalculation: string;
    readonly deductions: string;
    readonly unconditionalDiscount: string;
    readonly base: string;
    readonly rate: string;
    readonly retention: string;
    readonly issqn: string;
    /** Linhas que a nota 5 deixa suprimir quando não há dado em nenhum campo delas. */
    readonly showRegimeRow: boolean;
    readonly showBenefitRow: boolean;
  };
  readonly federalTax: {
    readonly irrf: string;
    readonly socialSecurity: string;
    readonly socialContributions: string;
    readonly pis: string;
    readonly cofins: string;
    readonly socialContributionsDescription: string;
    /** Nota 6: só para competência até o fim de 2026. */
    readonly showPisCofinsRow: boolean;
  };
  readonly ibsCbs: {
    readonly cstClassification: string;
    readonly operation: string;
    readonly exclusions: string;
    readonly base: string;
    readonly rateReductions: string;
    readonly ibsRates: string;
    readonly municipalEffectiveRate: string;
    readonly municipalAmount: string;
    readonly stateEffectiveRate: string;
    readonly stateAmount: string;
    readonly ibsTotal: string;
    readonly cbsRate: string;
    readonly cbsEffectiveRate: string;
    readonly cbsTotal: string;
  };
  readonly totals: {
    readonly serviceAmount: string;
    readonly unconditionalDiscount: string;
    readonly conditionalDiscount: string;
    readonly retentions: string;
    readonly netAmount: string;
    readonly ibsCbs: string;
    readonly netPlusIbsCbs: string;
  };
  readonly complementary: string;
  readonly approximateTaxes: string;
}

export interface DanfseInput {
  readonly document: NfseDocument;
  /** Chave de acesso gravada na autorização (as 50 posições de `infNFSe/@Id` sem o "NFS"). */
  readonly accessKey: string;
  readonly situation: 'AUTHORIZED' | 'CANCELLED' | 'SUBSTITUTED';
  readonly municipalities: MunicipalityLookup;
}

export const QR_CODE_BASE_URL = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';

export function buildDanfseView(input: DanfseInput): DanfseView {
  const { info, dps } = input.document;
  const lookup = input.municipalities;
  const tribMun = dps.at('valores', 'trib', 'tribMun');
  const tribFed = dps.at('valores', 'trib', 'tribFed');
  const pisCofins = tribFed.at('piscofins');
  const nfseValues = info.at('valores');
  const ibs = info.at('IBSCBS');
  const dpsIbs = dps.at('IBSCBS');
  const cTribNac = dps.text('serv', 'cServ', 'cTribNac');
  const competence = dps.text('dCompet');
  const tpRetPisCofins = pisCofins.text('tpRetPisCofins');
  const pisCofinsWithheld = tpRetPisCofins === '1';

  const emitUf = info.text('emit', 'enderNac', 'UF');
  const xLocEmi = info.text('xLocEmi');
  // Item 2.4.5: não exibir o município quando o item do código de tributação nacional for 99.
  const headerMunicipality = cTribNac?.slice(0, 2) === '99' || xLocEmi === undefined ? null : `Município: ${xLocEmi}${emitUf === undefined ? '' : ` / ${emitUf}`}`;

  return {
    homologation: dps.text('tpAmb') === '2',
    watermark: input.situation === 'CANCELLED' ? 'CANCELADA' : input.situation === 'SUBSTITUTED' ? 'SUBSTITUÍDA' : null,
    header: {
      municipality: headerMunicipality === null ? null : fit(headerMunicipality, 37),
      // NT 008, Anexo I: os dois campos têm tamanho 1, ou seja, o código, como no DANFSe do emissor nacional.
      generator: `Ambiente Gerador: ${info.text('ambGer') ?? DASH}`,
      environment: `Tipo de Ambiente: ${dps.text('tpAmb') ?? DASH}`,
    },
    identification: {
      accessKey: input.accessKey,
      number: fit(info.text('nNFSe'), 13),
      competence: date(competence),
      issuedAt: dateTime(info.text('dhProc')),
      dpsNumber: fit(dps.text('nDPS'), 15),
      dpsSeries: fit(dps.text('serie'), 5),
      dpsIssuedAt: dateTime(dps.text('dhEmi')),
      emitter: fit(coded(TP_EMIT, dps.text('tpEmit')), 13),
      status: fit(info.text('cStat') === undefined ? DASH : (nfseStatusDescription(info.text('cStat') ?? '') ?? info.text('cStat')), 40),
      purpose: fit(coded(FIN_NFSE, dps.text('finNFSe') ?? dpsIbs.text('finNFSe')), 40),
    },
    qrCodeUrl: `${QR_CODE_BASE_URL}${input.accessKey}`,
    provider: {
      ...providerParty(info, dps, lookup),
      simplesNacional: fit(coded(OP_SIMP_NAC, dps.text('prest', 'regTrib', 'opSimpNac')), 40),
      simplesNacionalRegime: fit(coded(REG_AP_TRIB_SN, dps.text('prest', 'regTrib', 'regApTribSN')), 80),
    },
    taker: partyBlock(dps.at('toma'), lookup, 'TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e'),
    recipient: recipientBlock(dpsIbs, lookup),
    intermediary: partyBlock(dps.at('interm'), lookup, 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e'),
    service: {
      taxCode: taxCode(cTribNac, dps.text('serv', 'cServ', 'cTribMun')),
      nbs: nbs(dps.text('serv', 'cServ', 'cNBS')),
      place: fit(place(info.text('xLocPrestacao'), dps.text('serv', 'locPrest', 'cLocPrestacao'), dps.text('serv', 'locPrest', 'cPaisPrestacao'), lookup), 42),
      taxCodeDescription: fit(info.text('xTribMun') ?? info.text('xTribNac'), 170),
      description: fit(dps.text('serv', 'cServ', 'xDescServ'), 1300),
    },
    municipalTax: {
      taxation: fit(coded(TRIB_ISSQN, tribMun.text('tribISSQN')), 21),
      incidence: fit(incidence(info.text('xLocIncid'), info.text('cLocIncid'), tribMun.text('cPaisResult'), lookup), 42),
      specialRegime: fit(coded(REG_ESP_TRIB, dps.text('prest', 'regTrib', 'regEspTrib')), 27),
      immunity: fit(coded(TP_IMUNIDADE, tribMun.text('tpImunidade')), 40),
      suspension: fit(coded(TP_SUSP, tribMun.text('exigSusp', 'tpSusp')), 40),
      suspensionProcess: fit(tribMun.text('exigSusp', 'nProcesso'), 30),
      benefit: fit(coded(TP_BM, nfseValues.text('tpBM')), 40),
      benefitCalculation: money(nfseValues.text('vCalcBM') ?? tribMun.text('BM', 'vRedBCBM')),
      deductions: money(deductions(dps, nfseValues, ibs)),
      unconditionalDiscount: money(dps.text('valores', 'vDescCondIncond', 'vDescIncond')),
      base: money(nfseValues.text('vBC')),
      rate: percent(nfseValues.text('pAliqAplic')),
      retention: fit(coded(TP_RET_ISSQN, tribMun.text('tpRetISSQN')), 25),
      issqn: money(nfseValues.text('vISSQN')),
      showRegimeRow: [dps.text('prest', 'regTrib', 'regEspTrib'), tribMun.text('tpImunidade'), tribMun.text('exigSusp', 'tpSusp'), tribMun.text('exigSusp', 'nProcesso')].some(Boolean),
      showBenefitRow: [nfseValues.text('tpBM'), nfseValues.text('vCalcBM'), tribMun.text('BM', 'vRedBCBM'), deductions(dps, nfseValues, ibs), dps.text('valores', 'vDescCondIncond', 'vDescIncond')].some(Boolean),
    },
    federalTax: {
      irrf: money(tribFed.text('vRetIRRF')),
      socialSecurity: money(tribFed.text('vRetCP')),
      // Item 2.4.5: com tpRetPisCofins = 1, CSLL + PIS + COFINS; nos demais casos, só a CSLL.
      socialContributions: money(pisCofinsWithheld ? sum(tribFed.text('vRetCSLL'), pisCofins.text('vPis'), pisCofins.text('vCofins')) : tribFed.text('vRetCSLL')),
      pis: money(pisCofinsWithheld ? '0.00' : pisCofins.text('vPis')),
      cofins: money(pisCofinsWithheld ? '0.00' : pisCofins.text('vCofins')),
      socialContributionsDescription: fit(coded(TP_RET_PIS_COFINS, tpRetPisCofins), 35),
      showPisCofinsRow: competence === undefined || competence <= '2026-12-31',
    },
    ibsCbs: ibsCbsBlock(dps, dpsIbs, ibs, nfseValues, lookup),
    totals: {
      serviceAmount: money(dps.text('valores', 'vServPrest', 'vServ')),
      unconditionalDiscount: money(dps.text('valores', 'vDescCondIncond', 'vDescIncond')),
      conditionalDiscount: money(dps.text('valores', 'vDescCondIncond', 'vDescCond')),
      retentions: money(nfseValues.text('vTotalRet')),
      netAmount: money(nfseValues.text('vLiq')),
      ibsCbs: money(sum(ibs.text('totCIBS', 'gIBS', 'vIBSTot'), ibs.text('totCIBS', 'gCBS', 'vCBS'))),
      netPlusIbsCbs: money(ibs.text('totCIBS', 'vTotNF')),
    },
    complementary: complementary(info, dps, dpsIbs),
    approximateTaxes: approximateTaxes(dps.at('valores', 'trib', 'totTrib')),
  };
}

function providerParty(info: NfseNode, dps: NfseNode, lookup: MunicipalityLookup): DanfseParty {
  const prest = dps.at('prest');
  // O grupo `prest` da DPS pode vir só com o documento quando quem emite é o próprio prestador;
  // nesse caso o autorizador grava nome, endereço e contato em `infNFSe/emit` (TCEmitente).
  const emit = dps.text('tpEmit') === '1' ? info.at('emit') : undefined;
  const base = party(prest, lookup);
  if (emit === undefined || !emit.exists) return base;
  const emitAddress = emit.at('enderNac');
  return {
    document: base.document,
    municipalRegistration: prest.text('IM') === undefined ? fit(emit.text('IM'), 15) : base.municipalRegistration,
    phone: prest.text('fone') === undefined ? fit(emit.text('fone'), 20) : base.phone,
    name: prest.text('xNome') === undefined ? fit(emit.text('xNome'), 80) : base.name,
    municipality: prest.at('end').exists ? base.municipality : fit(municipalityOf(emitAddress.text('cMun'), lookup), 37),
    ibgeAndPostalCode: prest.at('end').exists ? base.ibgeAndPostalCode : fit(joinSlash(emitAddress.text('cMun'), cep(emitAddress.text('CEP'))), 21),
    address: prest.at('end').exists ? base.address : fit(addressOf(emitAddress), 80),
    email: prest.text('email') === undefined ? fit(emit.text('email'), 80) : base.email,
  };
}

function partyBlock(node: NfseNode, lookup: MunicipalityLookup, missing: string): DanfsePartyBlock {
  return node.exists ? { kind: 'PARTY', party: party(node, lookup) } : { kind: 'MESSAGE', message: missing };
}

/** Destinatário (grupo IBSCBS/dest). Com indDest 0, o destinatário é o próprio tomador (TSRTCIndDest). */
function recipientBlock(dpsIbs: NfseNode, lookup: MunicipalityLookup): DanfsePartyBlock {
  const dest = dpsIbs.at('dest');
  if (dest.exists) return { kind: 'PARTY', party: party(dest, lookup) };
  if (dpsIbs.text('indDest') === '0') return { kind: 'MESSAGE', message: 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO' };
  return { kind: 'MESSAGE', message: 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' };
}

function party(node: NfseNode, lookup: MunicipalityLookup): DanfseParty {
  const end = node.at('end');
  const national = end.at('endNac');
  const foreign = end.at('endExt');
  return {
    document: documentOf(node),
    municipalRegistration: fit(node.text('IM'), 15),
    phone: fit(node.text('fone'), 20),
    name: fit(node.text('xNome'), 80),
    municipality: fit(national.exists ? municipalityOf(national.text('cMun'), lookup) : foreign.text('xCidade'), 37),
    ibgeAndPostalCode: fit(national.exists ? joinSlash(national.text('cMun'), cep(national.text('CEP'))) : foreign.text('cEndPost'), 21),
    address: fit(end.exists ? addressOf(end) : undefined, 80),
    email: fit(node.text('email'), 80),
  };
}

/** CNPJ / CPF com máscara; NIF como veio (item 2.4.5: nn.nnn.nnn/nnnn-nn / nnn.nnn.nnn-nn / nnn). */
function documentOf(node: NfseNode): string {
  const cnpj = node.text('CNPJ');
  if (cnpj !== undefined && cnpj.length === 14) return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
  const cpf = node.text('CPF');
  if (cpf !== undefined && cpf.length === 11) return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
  return fit(cnpj ?? cpf ?? node.text('NIF'), 40);
}

function addressOf(node: NfseNode): string | undefined {
  const parts = [node.text('xLgr'), node.text('nro'), node.text('xCpl'), node.text('xBairro')].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(', ');
}

function municipalityOf(code: string | undefined, lookup: MunicipalityLookup): string | undefined {
  if (code === undefined) return undefined;
  const found = lookup(code);
  return found === undefined ? code : `${found.name} / ${found.uf}`;
}

function place(name: string | undefined, municipality: string | undefined, country: string | undefined, lookup: MunicipalityLookup): string | undefined {
  if (municipality !== undefined) return [name ?? lookup(municipality)?.name ?? municipality, lookup(municipality)?.uf, 'BR'].filter(Boolean).join(' / ');
  return country === undefined ? name : [name, country].filter(Boolean).join(' / ');
}

function incidence(name: string | undefined, municipality: string | undefined, resultCountry: string | undefined, lookup: MunicipalityLookup): string | undefined {
  if (municipality !== undefined) return place(name, municipality, undefined, lookup);
  return resultCountry ?? name;
}

function taxCode(national: string | undefined, municipal: string | undefined): string {
  if (national === undefined) return DASH;
  const masked = national.length === 6 ? `${national.slice(0, 2)}.${national.slice(2, 4)}.${national.slice(4)}` : national;
  return municipal === undefined ? masked : `${masked} / ${municipal}`;
}

function nbs(code: string | undefined): string {
  if (code === undefined) return DASH;
  return code.length === 9 ? `${code.slice(0, 1)}.${code.slice(1, 5)}.${code.slice(5, 7)}.${code.slice(7)}` : code;
}

/**
 * Total de deduções/reduções (item 2.4.5): `vDR` da DPS ou `vCalcDR` da NFS-e, mais `vCalcReeRepRes`.
 * Na produção restrita o leiaute usa outros nomes (`vCalcAjusteBCISSQN`; R-45), lidos na falta dos primeiros.
 */
function deductions(dps: NfseNode, nfseValues: NfseNode, ibs: NfseNode): string | undefined {
  const base = nfseValues.text('vCalcDR') ?? dps.text('valores', 'vDedRed', 'vDR') ?? nfseValues.text('vCalcAjusteBCISSQN');
  return sum(base, ibs.text('valores', 'vCalcReeRepRes'));
}

function ibsCbsBlock(dps: NfseNode, dpsIbs: NfseNode, ibs: NfseNode, nfseValues: NfseNode, lookup: MunicipalityLookup): DanfseView['ibsCbs'] {
  const trib = dpsIbs.at('valores', 'trib', 'gIBSCBS');
  const values = ibs.at('valores');
  const totals = ibs.at('totCIBS');
  const pisCofins = dps.at('valores', 'trib', 'tribFed', 'piscofins');
  const incidenceCode = ibs.text('cLocalidadeIncid');
  const operation = [dpsIbs.text('cIndOp'), incidenceCode, ibs.text('xLocalidadeIncid'), incidenceCode === undefined ? undefined : lookup(incidenceCode)?.uf].filter(Boolean).join(' / ');
  const exclusions = ibs.exists
    ? sum(dps.text('valores', 'vDescCondIncond', 'vDescIncond'), values.text('vCalcReeRepRes'), nfseValues.text('vISSQN'), pisCofins.text('vPis'), pisCofins.text('vCofins'))
    : undefined;
  return {
    cstClassification: fit(joinSlash(trib.text('CST'), trib.text('cClassTrib')), 12),
    operation: fit(operation === '' ? undefined : operation, 56),
    exclusions: money(exclusions),
    base: money(values.text('vBC')),
    rateReductions: percents(values.text('uf', 'pRedAliqUF'), values.text('mun', 'pRedAliqMun'), values.text('fed', 'pRedAliqCBS')),
    ibsRates: percents(values.text('uf', 'pIBSUF'), values.text('mun', 'pIBSMun')),
    municipalEffectiveRate: percent(values.text('mun', 'pAliqEfetMun')),
    municipalAmount: money(totals.text('gIBS', 'gIBSMunTot', 'vIBSMun')),
    stateEffectiveRate: percent(values.text('uf', 'pAliqEfetUF')),
    stateAmount: money(totals.text('gIBS', 'gIBSUFTot', 'vIBSUF')),
    ibsTotal: money(totals.text('gIBS', 'vIBSTot')),
    cbsRate: percent(values.text('fed', 'pCBS')),
    cbsEffectiveRate: percent(values.text('fed', 'pAliqEfetCBS')),
    cbsTotal: money(totals.text('gCBS', 'vCBS')),
  };
}

/** Informações complementares, na ordem e com os prefixos do item 2.4.5, separadas por " | ". */
function complementary(info: NfseNode, dps: NfseNode, dpsIbs: NfseNode): string {
  const serv = dps.at('serv');
  const infoCompl = serv.at('infoCompl');
  const items = infoCompl.at('gItemPed').all('xItemPed').map((n) => n.text()).filter((t): t is string => t !== undefined);
  const parts: [string, string | undefined][] = [
    ['Inf. Cont.', infoCompl.text('xInfComp')],
    ['NFS-e Subst.', dps.text('subst', 'chSubstda')],
    ['Doc. Ref.', infoCompl.text('docRef')],
    ['Cod. Obra', serv.text('obra', 'cObra')],
    ['Insc. Imob.', dpsIbs.text('imovel', 'inscImobFisc') ?? serv.text('obra', 'inscImobFisc')],
    ['Cod. Evt.', serv.text('atvEvento', 'idAtvEvt')],
    ['Doc. Tec.', infoCompl.text('idDocTec')],
    ['Núm. Ped.', infoCompl.text('xPed')],
    ['Item Ped.', items.length === 0 ? undefined : items.join(', ')],
    ['Inf. A. T. Mun.', info.text('xOutInf')],
  ];
  const text = parts.filter(([, value]) => value !== undefined).map(([label, value]) => `${label}: ${value ?? ''}`).join(' | ');
  return text === '' ? DASH : fit(text, 2000);
}

/** Nota 10: linha obrigatória, com valores monetários OU percentuais, como o XML informar. */
function approximateTaxes(totTrib: NfseNode): string {
  const monetary = totTrib.at('vTotTrib');
  const percentage = totTrib.at('pTotTrib');
  const [fed, est, mun] = monetary.exists
    ? [money(monetary.text('vTotTribFed')), money(monetary.text('vTotTribEst')), money(monetary.text('vTotTribMun'))]
    : percentage.exists
      ? [percent(percentage.text('pTotTribFed')), percent(percentage.text('pTotTribEst')), percent(percentage.text('pTotTribMun'))]
      : [DASH, DASH, DASH];
  return `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: ${fed}; Estaduais: ${est}; Municipais: ${mun}`;
}

// ---------------------------------------------------------------------------------------------
// Formatação

/** Texto que cabe no campo; maior que `size` → corta e termina com "..." (item 2.1). */
export function fit(value: string | undefined, size: number): string {
  if (value === undefined || value === '') return DASH;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= size ? clean : `${clean.slice(0, size - 3)}...`;
}

function coded(catalog: Readonly<Record<string, string>>, code: string | undefined): string {
  return describe(catalog, code) ?? code ?? DASH;
}

function joinSlash(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined && b === undefined) return undefined;
  return `${a ?? DASH} / ${b ?? DASH}`;
}

function cep(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{8}$/.test(value) ? `${value.slice(0, 2)}.${value.slice(2, 5)}-${value.slice(5)}` : value;
}

/** AAAA-MM-DD → DD/MM/AAAA. */
export function date(value: string | undefined): string {
  const m = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m === null ? (value ?? DASH) : `${m[3]}/${m[2]}/${m[1]}`;
}

/** TSDateTimeUTC (AAAA-MM-DDThh:mm:ss±hh:mm) → DD/MM/AAAA hh:mm:ss, no fuso que veio no XML. */
export function dateTime(value: string | undefined): string {
  const m = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  return m === null ? (value ?? DASH) : `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
}

/** Decimal do XML (TSDec15V2, ponto) → R$ 1.234,56. */
export function money(value: string | undefined): string {
  const cents = toCents(value);
  if (cents === undefined) return value ?? DASH;
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const integer = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}R$ ${integer},${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Percentual do XML (ponto) → 5,00%. */
export function percent(value: string | undefined): string {
  if (value === undefined) return DASH;
  return /^-?\d+(\.\d+)?$/.test(value) ? `${value.replace('.', ',')}%` : value;
}

function percents(...values: (string | undefined)[]): string {
  return values.every((v) => v === undefined) ? DASH : values.map(percent).join(' / ');
}

/** Soma exata em centavos dos valores presentes; nenhum presente → `undefined`. */
function sum(...values: (string | undefined)[]): string | undefined {
  const present = values.map(toCents).filter((c): c is bigint => c !== undefined);
  if (present.length === 0) return undefined;
  const total = present.reduce((a, b) => a + b, 0n);
  const negative = total < 0n;
  const abs = negative ? -total : total;
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

function toCents(value: string | undefined): bigint | undefined {
  const m = value === undefined ? null : /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (m === null) return undefined;
  const cents = BigInt(m[2] ?? '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -cents : cents;
}
