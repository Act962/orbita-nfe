import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildDanfseView, date, dateTime, fit, money, percent, QR_CODE_BASE_URL } from './danfse-view.js';
import { readNfseDocument } from './nfse-document.js';
import { renderDanfse } from './danfse-pdf.js';

/**
 * DANFSe (ADR-0057, NT 008 SE/CGNFS-e v1.02). XML FICTÍCIO: os valores só exercitam as regras de
 * impressão da NT, não são enquadramento de ninguém.
 */
const KEY = '22110012211222333000181000000000000126110000000001';

function nfse(options: { toma?: string; dCompet?: string; tpAmb?: string; tpRetPisCofins?: string; interm?: string; ibscbs?: string; totTrib?: string } = {}): string {
  const toma =
    options.toma ??
    '<toma><CPF>12345678909</CPF><xNome>Fulano de Tal</xNome><end><endNac><cMun>3550308</cMun><CEP>01001000</CEP></endNac><xLgr>Praça da Sé</xLgr><nro>1</nro><xBairro>Sé</xBairro></end><email>fulano@example.com</email></toma>';
  return (
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${KEY}">` +
    '<xLocEmi>Teresina</xLocEmi><xLocPrestacao>Teresina</xLocPrestacao><nNFSe>1</nNFSe><cLocIncid>2211001</cLocIncid><xLocIncid>Teresina</xLocIncid>' +
    '<xTribNac>Descrição nacional</xTribNac><verAplic>v</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat>' +
    '<dhProc>2026-11-11T10:15:30-03:00</dhProc><nDFSe>1</nDFSe>' +
    '<emit><CNPJ>11222333000181</CNPJ><xNome>EMPRESA FICTICIA LTDA</xNome><enderNac><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><cMun>2211001</cMun><UF>PI</UF><CEP>64000000</CEP></enderNac><fone>86999990000</fone></emit>' +
    '<valores><vBC>1000.00</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>20.00</vISSQN><vTotalRet>45.50</vTotalRet><vLiq>954.50</vLiq></valores>' +
    (options.ibscbs ?? '') +
    '<DPS versao="1.01"><infDPS Id="DPS221100121122233300018100001000000000000001">' +
    `<tpAmb>${options.tpAmb ?? '2'}</tpAmb><dhEmi>2026-11-11T10:00:00-03:00</dhEmi><verAplic>v</verAplic><serie>1</serie><nDPS>1</nDPS>` +
    `<dCompet>${options.dCompet ?? '2026-11-11'}</dCompet><tpEmit>1</tpEmit><finNFSe>0</finNFSe><cLocEmi>2211001</cLocEmi>` +
    '<prest><CNPJ>11222333000181</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>' +
    toma +
    (options.interm ?? '') +
    '<serv><locPrest><cLocPrestacao>2211001</cLocPrestacao></locPrest><cServ><cTribNac>010101</cTribNac><cNBS>123456789</cNBS><xDescServ>Serviço fictício</xDescServ></cServ>' +
    '<infoCompl><xInfComp>Pedido interno</xInfComp><xPed>PED-1</xPed></infoCompl></serv>' +
    '<valores><vServPrest><vServ>1000.00</vServ></vServPrest><vDescCondIncond><vDescIncond>10.00</vDescIncond></vDescCondIncond>' +
    '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>' +
    `<tribFed><piscofins><CST>01</CST><vPis>6.50</vPis><vCofins>30.00</vCofins><tpRetPisCofins>${options.tpRetPisCofins ?? '1'}</tpRetPisCofins></piscofins><vRetCSLL>9.00</vRetCSLL></tribFed>` +
    (options.totTrib ?? '<totTrib><vTotTrib><vTotTribFed>100.00</vTotTribFed><vTotTribEst>0.00</vTotTribEst><vTotTribMun>20.00</vTotTribMun></vTotTrib></totTrib>') +
    '</trib></valores></infDPS></DPS></infNFSe></NFSe>'
  );
}

const municipalities = (code: string) => ({ '2211001': { name: 'Teresina', uf: 'PI' }, '3550308': { name: 'São Paulo', uf: 'SP' } })[code];

const view = (xml: string, situation: 'AUTHORIZED' | 'CANCELLED' | 'SUBSTITUTED' = 'AUTHORIZED') =>
  buildDanfseView({ document: readNfseDocument(xml), accessKey: KEY, situation, municipalities });

describe('DANFSe: conteúdo (NT 008 v1.02, item 2.4.5)', () => {
  it('identificação, QR Code e cabeçalho da nota de teste', () => {
    const v = view(nfse());
    expect(v.homologation).toBe(true);
    expect(v.qrCodeUrl).toBe(`${QR_CODE_BASE_URL}${KEY}`);
    expect(v.header).toEqual({ municipality: 'Município: Teresina / PI', generator: 'Ambiente Gerador: 2', environment: 'Tipo de Ambiente: 2' });
    expect(v.identification.issuedAt).toBe('11/11/2026 10:15:30');
    expect(v.identification.competence).toBe('11/11/2026');
    expect(v.identification.emitter).toBe('Prestador');
    expect(v.identification.status).toBe('NFS-e Gerada');
    expect(v.identification.purpose).toBe('NFS-e regular');
  });

  it('prestador: dados de infNFSe/emit quando o próprio prestador emite; máscaras de CNPJ, CPF e CEP', () => {
    const v = view(nfse());
    expect(v.provider.document).toBe('11.222.333/0001-81');
    expect(v.provider.name).toBe('EMPRESA FICTICIA LTDA');
    expect(v.provider.municipality).toBe('Teresina / PI');
    expect(v.provider.ibgeAndPostalCode).toBe('2211001 / 64.000-000');
    // Telefone com DDD formatado como no emissor nacional; fora de 10/11 dígitos, como veio.
    expect(v.provider.phone).toBe('(86) 99999-0000');
    expect(view(nfse().replace('86999990000', '8632220000')).provider.phone).toBe('(86) 3222-0000');
    expect(view(nfse().replace('86999990000', '5511999990000')).provider.phone).toBe('5511999990000');
    // Item 2.4.5: até 40 posições; acima de 37, corta com reticências.
    expect(v.provider.simplesNacional).toBe('Optante - Microempresa ou Empresa de ...');
    expect(v.taker).toEqual({
      kind: 'PARTY',
      party: {
        document: '123.456.789-09',
        municipalRegistration: '-',
        phone: '-',
        name: 'Fulano de Tal',
        municipality: 'São Paulo / SP',
        ibgeAndPostalCode: '3550308 / 01.001-000',
        address: 'Praça da Sé, 1, Sé',
        email: 'fulano@example.com',
      },
    });
  });

  it('notas 2 e 3: blocos sem dados recebem as frases da NT', () => {
    const v = view(nfse({ toma: '' }));
    expect(v.taker).toEqual({ kind: 'MESSAGE', message: 'TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' });
    expect(v.intermediary).toEqual({ kind: 'MESSAGE', message: 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' });
    expect(v.recipient).toEqual({ kind: 'MESSAGE', message: 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e' });
    const own = view(nfse({ ibscbs: '' }).replace('<serv>', '<IBSCBS><indDest>0</indDest></IBSCBS><serv>'));
    // TSRTCIndDest 0: o destinatário é o próprio tomador (a ordem dos grupos não importa para a leitura).
    expect(own.recipient).toEqual({ kind: 'MESSAGE', message: 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO' });
  });

  it('serviço: máscaras do código de tributação e da NBS; local com UF e país', () => {
    const v = view(nfse());
    expect(v.service.taxCode).toBe('01.01.01');
    expect(v.service.nbs).toBe('1.2345.67.89');
    expect(v.service.place).toBe('Teresina / PI / BR');
    expect(v.service.taxCodeDescription).toBe('Descrição nacional');
    expect(v.municipalTax.incidence).toBe('Teresina / PI / BR');
    expect(v.municipalTax.taxation).toBe('Operação tributável');
    expect(v.municipalTax.rate).toBe('2,00%');
  });

  it('tributação federal: com tpRetPisCofins 1, as retidas somam CSLL + PIS + COFINS e o débito próprio sai zerado', () => {
    const withheld = view(nfse()).federalTax;
    expect(withheld.socialContributions).toBe('R$ 45,50');
    expect(withheld.pis).toBe('R$ 0,00');
    expect(withheld.cofins).toBe('R$ 0,00');
    expect(withheld.socialContributionsDescription).toBe('PIS/COFINS Retidos');
    const own = view(nfse({ tpRetPisCofins: '2' })).federalTax;
    expect(own.socialContributions).toBe('R$ 9,00');
    expect(own.pis).toBe('R$ 6,50');
    expect(own.cofins).toBe('R$ 30,00');
  });

  it('nota 6: a linha de PIS/COFINS de apuração própria só sai com competência até 31/12/2026', () => {
    expect(view(nfse({ dCompet: '2026-12-31' })).federalTax.showPisCofinsRow).toBe(true);
    expect(view(nfse({ dCompet: '2027-01-01' })).federalTax.showPisCofinsRow).toBe(false);
  });

  it('nota 12: sem IBS/CBS no XML, os campos saem com traço; as exclusões somam os campos que existem', () => {
    const v = view(nfse());
    const { exclusions, ...others } = v.ibsCbs;
    expect(Object.values(others).every((value) => value === '-')).toBe(true);
    // Anexo I: vDescIncond 10,00 + vISSQN 20,00 + vPIS 6,50 + vCOFINS 30,00 (como no gerador da Receita).
    expect(exclusions).toBe('R$ 66,50');
    expect(view(nfse().replace(/<vDescCondIncond>.*?<\/vDescCondIncond>/, '').replace(/<vISSQN>.*?<\/vISSQN>/, '').replace(/<piscofins>.*?<\/piscofins>/, '')).ibsCbs.exclusions).toBe('-');
    expect(v.totals.netPlusIbsCbs).toBe('-');
    expect(v.totals.serviceAmount).toBe('R$ 1.000,00');
    expect(v.totals.netAmount).toBe('R$ 954,50');
  });

  it('informações complementares em ordem, com pipes, e a linha obrigatória dos totais aproximados (nota 10)', () => {
    const v = view(nfse());
    expect(v.complementary).toBe('Inf. Cont.: Pedido interno | Núm. Ped.: PED-1');
    expect(v.approximateTaxes).toBe('Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: R$ 100,00; Estaduais: R$ 0,00; Municipais: R$ 20,00');
    const pct = view(nfse({ totTrib: '<totTrib><pTotTrib><pTotTribFed>10.50</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>2.00</pTotTribMun></pTotTrib></totTrib>' }));
    expect(pct.approximateTaxes).toBe('Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: 10,50%; Estaduais: 0,00%; Municipais: 2,00%');
  });

  it('marca d\'água pela situação atual; produção sem o aviso de teste', () => {
    expect(view(nfse(), 'CANCELLED').watermark).toBe('CANCELADA');
    expect(view(nfse(), 'SUBSTITUTED').watermark).toBe('SUBSTITUÍDA');
    expect(view(nfse()).watermark).toBeNull();
    expect(view(nfse({ tpAmb: '1' })).homologation).toBe(false);
  });

  it('XML sem infNFSe é recusado com código estável', () => {
    expect(() => readNfseDocument('<x/>')).toThrow('NFSE_INFO_MISSING');
    expect(() => readNfseDocument('<<')).toThrow('NFSE_XML_UNREADABLE');
  });
});

describe('DANFSe: formatação', () => {
  it('texto que não cabe termina com reticências (item 2.1); vazio vira traço (nota 12)', () => {
    expect(fit('abcdef', 5)).toBe('ab...');
    expect(fit('abc', 5)).toBe('abc');
    expect(fit(undefined, 5)).toBe('-');
  });

  it('datas, valores e percentuais', () => {
    expect(date('2026-01-31')).toBe('31/01/2026');
    expect(dateTime('2026-01-31T23:59:58-03:00')).toBe('31/01/2026 23:59:58');
    expect(money('1234567.8')).toBe('R$ 1.234.567,80');
    expect(money('0.00')).toBe('R$ 0,00');
    expect(percent('2.5')).toBe('2,5%');
  });
});

describe('DANFSe: PDF', () => {
  it('gera uma página A4 com o QR Code e a marca d\'água, sem falhar em caractere fora do WinAnsi', async () => {
    const xml = nfse().replace('Serviço fictício', 'Serviço fictício ✓ com emoji 🚀 e texto longo '.repeat(40));
    const pdf = await renderDanfse(view(xml, 'CANCELLED'), { logoPng: TINY_PNG });
    expect(Buffer.from(pdf).toString('latin1', 0, 5)).toBe('%PDF-');
    const loaded = await PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBe(1);
    const { width, height } = loaded.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
  });
});

/** PNG 1x1 transparente (só para o teste não depender do arquivo oficial). */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
