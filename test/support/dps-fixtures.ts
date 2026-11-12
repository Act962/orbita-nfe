/**
 * DPS MÍNIMAS para testar a validação contra os XSD oficiais.
 *
 * Contêm só os elementos obrigatórios de `TCDPS` em cada pacote, com valores FICTÍCIOS que
 * respeitam os tipos do XSD. Não representam enquadramento tributário, código de serviço nem
 * regra fiscal: os códigos (opSimpNac, regEspTrib, cTribNac, tribISSQN, tpRetISSQN) foram
 * escolhidos só por pertencerem à enumeração ou ao padrão do tipo. Nunca use como modelo de
 * emissão.
 */
export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';

export const MUNICIPIO_FICTICIO = '2211001'; // 7 dígitos (TSCodMunIBGE)
export const CNPJ_FICTICIO = '11222333000181';

export interface DpsFixtureOptions {
  readonly serie?: string;
  readonly nDPS?: string;
  readonly vServ?: string;
  /** Inclui `finNFSe` (obrigatório no pacote de produção restrita de 20/10/2026). */
  readonly withFinNFSe?: boolean;
  readonly xDescServ?: string;
}

/** Id da DPS (TSIdDPS): "DPS" + município (7) + tipo de inscrição (1) + inscrição (14) + série (5) + número (15). */
export function dpsId(serie: string, nDPS: string): string {
  return `DPS${MUNICIPIO_FICTICIO}2${CNPJ_FICTICIO}${serie.padStart(5, '0')}${nDPS.padStart(15, '0')}`;
}

export function minimalDps(options: DpsFixtureOptions = {}): string {
  const serie = options.serie ?? '1';
  const nDPS = options.nDPS ?? '1';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="${NFSE_NS}" versao="1.01"><infDPS Id="${dpsId(serie, nDPS)}">` +
    `<tpAmb>2</tpAmb><dhEmi>2026-11-11T10:00:00-03:00</dhEmi><verAplic>orbita-nfe-teste</verAplic>` +
    `<serie>${serie}</serie><nDPS>${nDPS}</nDPS><dCompet>2026-11-11</dCompet><tpEmit>1</tpEmit>` +
    (options.withFinNFSe ? '<finNFSe>0</finNFSe>' : '') +
    `<cLocEmi>${MUNICIPIO_FICTICIO}</cLocEmi>` +
    `<prest><CNPJ>${CNPJ_FICTICIO}</CNPJ><regTrib><opSimpNac>3</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>` +
    `<serv><locPrest><cLocPrestacao>${MUNICIPIO_FICTICIO}</cLocPrestacao></locPrest>` +
    `<cServ><cTribNac>010101</cTribNac><xDescServ>${options.xDescServ ?? 'Servico ficticio de teste'}</xDescServ></cServ></serv>` +
    `<valores><vServPrest><vServ>${options.vServ ?? '100.00'}</vServ></vServPrest>` +
    `<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>` +
    `<totTrib><vTotTrib><vTotTribFed>0.00</vTotTribFed><vTotTribEst>0.00</vTotTribEst><vTotTribMun>0.00</vTotTribMun></vTotTrib></totTrib></trib></valores>` +
    `</infDPS></DPS>`
  );
}

/** A DPS mínima de cada pacote versionado. */
export const MINIMAL_DPS_BY_PACKAGE: Record<string, (o?: DpsFixtureOptions) => string> = {
  'nfse-nacional/1.01-20260209': (o) => minimalDps({ ...o, withFinNFSe: false }),
  'nfse-nacional/1.01-20261020-prodrest': (o) => minimalDps({ ...o, withFinNFSe: true }),
};
