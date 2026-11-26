import { Decimal } from '../../../../shared/domain/decimal.js';
import { saleTotals, type ConsumerSale, type ConsumerSaleItem } from '../../domain/consumer-sale.js';
import { NFE_NS } from '../sefaz/sefaz-soap.js';

/**
 * Montagem determinística do XML da NFC-e 4.00 (ADR-0069) a partir da venda v1.
 *
 * - A ordem dos elementos segue a `xs:sequence` de `TNFe` no `leiauteNFe_v4.00.xsd` do PL_010h.
 * - Os valores fixos do modelo 65 citam a regra que os impõe. Nenhum valor fiscal é escolhido:
 *   o que não tem regra vem da venda (cliente) ou do cadastro (emitente).
 * - O resultado ainda não tem assinatura nem `infNFeSupl` (ver `finishNfceXml`).
 */
export interface NfceIssuerData {
  readonly cnpj: string;
  readonly name: string;
  readonly tradeName?: string | undefined;
  readonly address: {
    readonly street: string;
    readonly number: string;
    readonly complement?: string | undefined;
    readonly district: string;
    readonly municipalityCode: string;
    readonly municipalityName: string;
    readonly uf: string;
    readonly postalCode: string;
    readonly phone?: string | undefined;
  };
  readonly stateRegistration: string;
  /** CRT do cadastro (a v1 só aceita 1, conferido em `checkConsumerSale`). */
  readonly taxRegime: '1';
}

export interface NfceXmlInput {
  readonly accessKey: { readonly value: string; readonly id: string; readonly checkDigit: string };
  readonly cUF: string;
  readonly numericCode: string;
  readonly series: number;
  readonly number: number;
  /** dhEmi já formatado (TDateTimeUTC, ex.: 2026-11-26T10:00:00-03:00). */
  readonly issuedAt: string;
  readonly tpAmb: '1' | '2';
  /** verProc: versão do motor. */
  readonly appVersion: string;
  readonly issuer: NfceIssuerData;
  readonly sale: ConsumerSale;
}

const PRESENCE = { IN_PERSON: '1', IN_PERSON_OFF_PREMISES: '5' } as const;

export function buildNfceXml(input: NfceXmlInput): string {
  const { sale, issuer } = input;
  const totals = saleTotals(sale);

  const ide =
    el('cUF', input.cUF) +
    el('cNF', input.numericCode) +
    el('natOp', sale.operationNature) +
    el('mod', '65') +
    el('serie', String(input.series)) +
    el('nNF', String(input.number)) +
    el('dhEmi', input.issuedAt) +
    el('tpNF', '1') + // B11-10: NFC-e não pode ser de entrada
    el('idDest', '1') + // B11a-10: só operação interna
    el('cMunFG', issuer.address.municipalityCode) +
    el('tpImp', '4') + // B21-10 aceita 4 (DANFE NFC-e) ou 5 (mensagem eletrônica); a v1 imprime o DANFE NFC-e
    el('tpEmis', '1') + // emissão normal; contingência depende do ADR-0067
    el('cDV', input.accessKey.checkDigit) +
    el('tpAmb', input.tpAmb) +
    el('finNFe', '1') + // B25-20: só finalidade normal
    el('indFinal', '1') + // B25a-10: consumidor final
    el('indPres', PRESENCE[sale.presence]) + // B25b-20: 1, 4 ou 5 (o 4 fica fora da v1)
    el('procEmi', '0') + // TProcEmi 0: aplicativo do contribuinte
    el('verProc', input.appVersion);

  const address = issuer.address;
  const emit =
    el('CNPJ', issuer.cnpj) +
    el('xNome', issuer.name) +
    opt('xFant', issuer.tradeName) +
    group(
      'enderEmit',
      el('xLgr', address.street) +
        el('nro', address.number) +
        opt('xCpl', address.complement) +
        el('xBairro', address.district) +
        el('cMun', address.municipalityCode) +
        el('xMun', address.municipalityName) +
        el('UF', address.uf) +
        el('CEP', address.postalCode) +
        opt('fone', address.phone),
    ) +
    el('IE', issuer.stateRegistration) +
    el('CRT', issuer.taxRegime);

  const dest = sale.consumer === undefined ? '' : group('dest', consumer(sale.consumer));
  const det = sale.items.map((it, index) => `<det nItem="${String(index + 1)}">${product(it)}${taxes(it)}${opt('infAdProd', it.additionalInfo)}</det>`).join('');

  const zero = '0.00';
  const icmsTot =
    el('vBC', zero) +
    el('vICMS', zero) +
    el('vICMSDeson', zero) +
    el('vFCP', zero) +
    el('vBCST', zero) +
    el('vST', zero) +
    el('vFCPST', zero) +
    el('vFCPSTRet', money(totals.fcpStRetained)) +
    el('vProd', money(totals.products)) +
    el('vFrete', zero) +
    el('vSeg', zero) +
    el('vDesc', money(totals.discount)) +
    el('vII', zero) +
    el('vIPI', zero) +
    el('vIPIDevol', zero) +
    el('vPIS', money(totals.pis)) +
    el('vCOFINS', money(totals.cofins)) +
    el('vOutro', money(totals.otherCharges)) +
    el('vNF', money(totals.invoice)) +
    (totals.approximateTaxes === undefined ? '' : el('vTotTrib', money(totals.approximateTaxes)));

  const pag =
    sale.payments
      .map((p) =>
        group(
          'detPag',
          el('tPag', p.method) +
            opt('xPag', p.description) +
            el('vPag', p.amount) +
            (p.card === undefined
              ? ''
              : group('card', el('tpIntegra', p.card.integration) + opt('CNPJ', p.card.acquirerCnpj) + opt('tBand', p.card.brand) + opt('cAut', p.card.authorization))),
        ),
      )
      .join('') + (totals.change === undefined ? '' : el('vTroco', money(totals.change)));

  const infAdic = sale.additionalInfo === undefined ? '' : group('infAdic', el('infCpl', sale.additionalInfo));

  const infNFe =
    group('ide', ide) +
    group('emit', emit) +
    dest +
    det +
    group('total', group('ICMSTot', icmsTot)) +
    group('transp', el('modFrete', '9')) + // X02-10: frete só com entrega a domicílio (fora da v1)
    group('pag', pag) +
    infAdic;

  return `<NFe xmlns="${NFE_NS}"><infNFe versao="4.00" Id="${input.accessKey.id}">${infNFe}</infNFe></NFe>`;
}

function consumer(c: NonNullable<ConsumerSale['consumer']>): string {
  const doc = 'cpf' in c.document ? el('CPF', c.document.cpf) : 'cnpj' in c.document ? el('CNPJ', c.document.cnpj) : el('idEstrangeiro', c.document.foreignId);
  // E16a-10: na NFC-e o destinatário é sempre "9 - Não Contribuinte".
  return doc + opt('xNome', c.name) + el('indIEDest', '9') + opt('email', c.email);
}

function product(it: ConsumerSaleItem): string {
  const taxable = it.taxable ?? { unit: it.unit, quantity: it.quantity, unitPrice: it.unitPrice, gtin: it.gtin };
  return group(
    'prod',
    el('cProd', it.code) +
      el('cEAN', it.gtin ?? 'SEM GTIN') +
      el('xProd', it.description) +
      el('NCM', it.ncm) +
      opt('CEST', it.cest) +
      el('CFOP', it.cfop) +
      el('uCom', it.unit) +
      el('qCom', it.quantity) +
      el('vUnCom', it.unitPrice) +
      el('vProd', it.amount) +
      el('cEANTrib', taxable.gtin ?? 'SEM GTIN') +
      el('uTrib', taxable.unit) +
      el('qTrib', taxable.quantity) +
      el('vUnTrib', taxable.unitPrice) +
      opt('vDesc', positive(it.discount)) +
      opt('vOutro', positive(it.otherCharges)) +
      el('indTot', '1'), // I17b-10: na NFC-e todo item compõe o total
  );
}

function taxes(it: ConsumerSaleItem): string {
  const icms = it.icms;
  let icmsGroup: string;
  if (icms.csosn === '500') {
    const st = icms.stRetained;
    const fcp = icms.fcpStRetained;
    const eff = icms.effective;
    icmsGroup = group(
      'ICMSSN500',
      el('orig', icms.origin) +
        el('CSOSN', '500') +
        (st === undefined ? '' : el('vBCSTRet', st.base) + el('pST', rate(st.consumerRate)) + opt('vICMSSubstituto', st.substituteOwnIcms) + el('vICMSSTRet', st.amount)) +
        (fcp === undefined ? '' : el('vBCFCPSTRet', fcp.base) + el('pFCPSTRet', rate(fcp.rate)) + el('vFCPSTRet', fcp.amount)) +
        (eff === undefined ? '' : el('pRedBCEfet', rate(eff.baseReductionRate)) + el('vBCEfet', eff.base) + el('pICMSEfet', rate(eff.rate)) + el('vICMSEfet', eff.amount)),
    );
  } else {
    icmsGroup = group('ICMSSN102', el('orig', icms.origin) + el('CSOSN', icms.csosn));
  }
  return group(
    'imposto',
    opt('vTotTrib', it.approximateTaxes) +
      group('ICMS', icmsGroup) +
      (it.pis === undefined ? '' : group('PIS', contribution('PIS', 'pPIS', 'vPIS', it.pis))) +
      (it.cofins === undefined ? '' : group('COFINS', contribution('COFINS', 'pCOFINS', 'vCOFINS', it.cofins))),
  );
}

function contribution(prefix: 'PIS' | 'COFINS', rateTag: string, amountTag: string, c: NonNullable<ConsumerSaleItem['pis']>): string {
  switch (c.group) {
    case 'RATE':
      return group(`${prefix}Aliq`, el('CST', c.cst) + el('vBC', c.base) + el(rateTag, rate(c.rate)) + el(amountTag, c.amount));
    case 'QUANTITY':
      return group(`${prefix}Qtde`, el('CST', c.cst) + el('qBCProd', c.quantityBase) + el('vAliqProd', c.ratePerUnit) + el(amountTag, c.amount));
    case 'NOT_TAXED':
      return group(`${prefix}NT`, el('CST', c.cst));
    case 'OTHER': {
      const basis =
        c.base !== undefined && c.rate !== undefined
          ? el('vBC', c.base) + el(rateTag, rate(c.rate))
          : el('qBCProd', c.quantityBase ?? '') + el('vAliqProd', c.ratePerUnit ?? '');
      return group(`${prefix}Outr`, el('CST', c.cst) + basis + el(amountTag, c.amount));
    }
  }
}

/** Insere `infNFeSupl` (QR Code e URL de consulta) entre `infNFe` e `Signature`, como manda o TNFe. */
export function finishNfceXml(signedXml: string, supplement: { readonly qrCode: string; readonly consultationUrl: string }): string {
  const at = signedXml.indexOf('<Signature');
  if (at < 0 || !signedXml.slice(0, at).endsWith('</infNFe>')) throw new Error('NFCE_XML_NOT_SIGNED');
  const supl = group('infNFeSupl', el('qrCode', supplement.qrCode) + el('urlChave', supplement.consultationUrl));
  return signedXml.slice(0, at) + supl + signedXml.slice(at);
}

/** TDec_1302: sempre com 2 casas (a soma de valores com 2 casas cabe em 2 casas). */
function money(value: Decimal): string {
  return value.toFixed(2);
}

/** TDec_0302a04: 0, ou de 2 a 4 casas decimais. */
function rate(value: string): string {
  const d = Decimal.of(value);
  return d.isZero() ? '0' : d.toFixed(Math.max(2, d.scale));
}

/** TDec_1302Opc não aceita zero: valor zero vira ausência do campo. */
function positive(value: string | undefined): string | undefined {
  return value === undefined || Decimal.of(value).isZero() ? undefined : value;
}

function el(name: string, value: string): string {
  return `<${name}>${escape(value)}</${name}>`;
}

function opt(name: string, value: string | undefined): string {
  return value === undefined ? '' : el(name, value);
}

function group(name: string, inner: string): string {
  return `<${name}>${inner}</${name}>`;
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
