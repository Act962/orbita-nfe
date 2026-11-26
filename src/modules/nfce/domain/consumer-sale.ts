import { Decimal } from '../../../shared/domain/decimal.js';
import type { ValidationIssue } from '../../../shared/domain/validation-issue.js';

/**
 * Contrato v1 da venda para NFC-e (ADR-0069), emitente do Simples Nacional (CRT=1).
 *
 * Os valores fiscais (CFOP, NCM, CEST, CSOSN, CST de PIS/COFINS, bases, alíquotas e valores)
 * vêm sempre do cliente. A forma (padrões do XSD do PL_010h) é conferida no contrato HTTP
 * (`presentation/http/consumer-sale-schema.ts`); aqui ficam as regras oficiais
 * citadas em cada verificação, e nunca escolhe nem completa um valor fiscal.
 *
 * Fontes das regras: NT 2026.002 v1.11 (regras do modelo 65 estendidas ao tpImp=6) e MOC 7.0,
 * Anexo I, inventariadas em docs/fiscal/regras/NFCE-ANEXO-I.md.
 */

export type IcmsOrigin = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

/** Grupo ICMSSN102 (CSOSN 102, 103, 300 ou 400) ou ICMSSN500 do leiaute. */
export type SaleIcms =
  | { readonly csosn: '102' | '103' | '300' | '400'; readonly origin: IcmsOrigin }
  | {
      readonly csosn: '500';
      readonly origin: IcmsOrigin;
      /** vBCSTRet, pST, vICMSSubstituto e vICMSSTRet. */
      readonly stRetained?: { readonly base: string; readonly consumerRate: string; readonly substituteOwnIcms?: string | undefined; readonly amount: string } | undefined;
      /** vBCFCPSTRet, pFCPSTRet e vFCPSTRet. */
      readonly fcpStRetained?: { readonly base: string; readonly rate: string; readonly amount: string } | undefined;
      /** pRedBCEfet, vBCEfet, pICMSEfet e vICMSEfet. */
      readonly effective?: { readonly baseReductionRate: string; readonly base: string; readonly rate: string; readonly amount: string } | undefined;
    };

/** PIS ou COFINS: o grupo do leiaute (Aliq, Qtde, NT, Outr) sai do CST informado. */
export type SaleContribution =
  | { readonly group: 'RATE'; readonly cst: '01' | '02'; readonly base: string; readonly rate: string; readonly amount: string }
  | { readonly group: 'QUANTITY'; readonly cst: '03'; readonly quantityBase: string; readonly ratePerUnit: string; readonly amount: string }
  | { readonly group: 'NOT_TAXED'; readonly cst: '04' | '05' | '06' | '07' | '08' | '09' }
  | {
      readonly group: 'OTHER';
      readonly cst: string;
      readonly base?: string | undefined;
      readonly rate?: string | undefined;
      readonly quantityBase?: string | undefined;
      readonly ratePerUnit?: string | undefined;
      readonly amount: string;
    };

/** Os decimais chegam como string já conferida contra o padrão do XSD (presentation/http). */
export interface ConsumerSaleItem {
  readonly code: string;
  /** null = produto sem GTIN ("SEM GTIN" no XML). */
  readonly gtin: string | null;
  readonly description: string;
  readonly ncm: string;
  readonly cest?: string | undefined;
  readonly cfop: string;
  readonly unit: string;
  readonly quantity: string;
  readonly unitPrice: string;
  /** vProd: informado pelo cliente e conferido contra quantidade × preço (regra I11-10). */
  readonly amount: string;
  readonly discount?: string | undefined;
  readonly otherCharges?: string | undefined;
  /** Unidade tributável. Ausente = a mesma da comercial. */
  readonly taxable?: { readonly unit: string; readonly quantity: string; readonly unitPrice: string; readonly gtin: string | null } | undefined;
  readonly icms: SaleIcms;
  readonly pis?: SaleContribution | undefined;
  readonly cofins?: SaleContribution | undefined;
  /** vTotTrib: valor aproximado dos tributos do item. */
  readonly approximateTaxes?: string | undefined;
  readonly additionalInfo?: string | undefined;
}

export interface SalePayment {
  /** tPag: código de dois dígitos da tabela oficial. */
  readonly method: string;
  readonly description?: string | undefined;
  readonly amount: string;
  readonly card?:
    | { readonly integration: '1' | '2'; readonly acquirerCnpj?: string | undefined; readonly brand?: string | undefined; readonly authorization?: string | undefined }
    | undefined;
}

export interface SaleConsumer {
  readonly document: { readonly cpf: string } | { readonly cnpj: string } | { readonly foreignId: string };
  readonly name?: string | undefined;
  readonly email?: string | undefined;
}

export interface ConsumerSale {
  readonly externalReference?: string | undefined;
  readonly operationNature: string;
  /** indPres: 1 presencial; 5 presencial fora do estabelecimento. O 4 (entrega) fica fora da v1. */
  readonly presence: 'IN_PERSON' | 'IN_PERSON_OFF_PREMISES';
  readonly consumer?: SaleConsumer | undefined;
  readonly items: readonly ConsumerSaleItem[];
  readonly payments: readonly SalePayment[];
  readonly additionalInfo?: string | undefined;
}

/** Emitente vindo do cadastro do estabelecimento, nunca do pedido. */
export interface SaleIssuer {
  readonly cnpj: string;
  /** CRT do cadastro. A v1 só emite para o Simples Nacional (1). */
  readonly taxRegime: '1' | '2' | '3' | '4';
}

/** CFOP aceitos por grupo de CSOSN (regras N12a-40 e N12a-44 da NT 2026.002 v1.11). */
const CFOP_BY_CSOSN: Readonly<Record<string, readonly string[]>> = {
  '102': ['5101', '5102', '5103', '5104', '5115', '5910'],
  '103': ['5101', '5102', '5103', '5104', '5115', '5910'],
  '300': ['5101', '5102', '5103', '5104', '5115', '5910'],
  '400': ['5101', '5102', '5103', '5104', '5115', '5910'],
  '500': ['5405', '5656', '5667', '5910'],
};

/** tPag recusados no modelo 65: 14 (YA02-10), 90 (YA02-40) e 99 (YA02-50). */
const REFUSED_PAYMENT_METHODS: Readonly<Record<string, string>> = { '14': 'YA02-10', '90': 'YA02-40', '99': 'YA02-50' };
/** tPag que exigem o grupo card: cartão de crédito (03), débito (04) e PIX (17) (YA04-10). */
const CARD_REQUIRED = new Set(['03', '04', '17']);

const CENT = Decimal.of('0.01');

export interface SaleTotals {
  readonly products: Decimal;
  readonly discount: Decimal;
  readonly otherCharges: Decimal;
  readonly fcpStRetained: Decimal;
  readonly pis: Decimal;
  readonly cofins: Decimal;
  readonly approximateTaxes: Decimal | undefined;
  /** vNF pela fórmula da W16-10, só com os termos que a v1 admite. */
  readonly invoice: Decimal;
  readonly paid: Decimal;
  /** vTroco = pagamentos − vNF (YA09-10), só quando positivo. */
  readonly change: Decimal | undefined;
}

const dec = (value: string): Decimal => Decimal.of(value);
const opt = (value: string | undefined): Decimal => (value === undefined ? Decimal.zero() : dec(value));

/** Totais da nota (grupo W). Somas exatas: nenhum arredondamento é aplicado. */
export function saleTotals(sale: ConsumerSale): SaleTotals {
  const sum = (pick: (i: ConsumerSaleItem) => string | undefined): Decimal => Decimal.sum(sale.items.map((i) => opt(pick(i))));
  const products = sum((i) => i.amount); // W07-10 (todos os itens com indTot=1, regra I17b-10)
  const discount = sum((i) => i.discount); // W10-10
  const otherCharges = sum((i) => i.otherCharges); // W15-10
  const fcpStRetained = sum((i) => (i.icms.csosn === '500' ? i.icms.fcpStRetained?.amount : undefined));
  const pis = sum((i) => (i.pis !== undefined && 'amount' in i.pis ? i.pis.amount : undefined)); // W13-10
  const cofins = sum((i) => (i.cofins !== undefined && 'amount' in i.cofins ? i.cofins.amount : undefined)); // W14-10
  const approximate = sale.items.some((i) => i.approximateTaxes !== undefined) ? sum((i) => i.approximateTaxes) : undefined;
  // W16-10: vProd − vDesc − vICMSDeson + vST + vFCPST + vFrete + vSeg + vOutro + vII + vIPI + vIPIDevol + vServ.
  // Na v1 (CSOSN 102/103/300/400/500, sem frete, seguro, IPI, II ou serviço) os demais termos são zero.
  const invoice = products.minus(discount).plus(otherCharges);
  const paid = Decimal.sum(sale.payments.map((p) => dec(p.amount)));
  const change = paid.compare(invoice) > 0 ? paid.minus(invoice) : undefined;
  return { products, discount, otherCharges, fcpStRetained, pis, cofins, approximateTaxes: approximate, invoice, paid, change };
}

/**
 * Regras do aceite que dependem só da venda e do cadastro. O que depende de parâmetro da UF
 * (W16-30, W16-40, N12a-30, CSOSN 900) fica com o autorizador até a SEFAZ-PI responder.
 */
export function checkConsumerSale(sale: ConsumerSale, issuer: SaleIssuer): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, message: string, field: string, ruleId?: string): void => {
    issues.push({ code, message, field, ...(ruleId === undefined ? {} : { ruleId }) });
  };

  if (issuer.taxRegime !== '1') {
    add('NFCE_REGIME_NOT_SUPPORTED', 'A v1 da NFC-e só emite para estabelecimento do Simples Nacional (CRT 1).', 'issuer.taxRegime');
  }

  sale.items.forEach((it, index) => {
    const at = `items[${String(index)}]`;
    const allowed = CFOP_BY_CSOSN[it.icms.csosn] ?? [];
    if (!allowed.includes(it.cfop)) {
      add('NFCE_CFOP_NOT_ALLOWED_FOR_CSOSN', `CFOP ${it.cfop} não é permitido com o CSOSN ${it.icms.csosn} na NFC-e.`, `${at}.cfop`, it.icms.csosn === '500' ? 'N12a-44' : 'N12a-40');
    }
    // I11-10: vProd = vUnCom × qCom arredondado em 2 casas, tolerância de R$ 0,01 (nota (*4) do Anexo I).
    const expected = dec(it.quantity).times(dec(it.unitPrice));
    if (!dec(it.amount).equalsWithin(expected, CENT)) {
      add('NFCE_ITEM_AMOUNT_MISMATCH', `amount (${it.amount}) difere de quantity × unitPrice (${expected.toString()}) em mais de R$ 0,01.`, `${at}.amount`, 'I11-10');
    }
    if (it.taxable !== undefined) {
      const taxableExpected = dec(it.taxable.quantity).times(dec(it.taxable.unitPrice));
      if (!dec(it.amount).equalsWithin(taxableExpected, CENT)) {
        add('NFCE_ITEM_TAXABLE_AMOUNT_MISMATCH', 'amount difere de taxable.quantity × taxable.unitPrice em mais de R$ 0,01.', `${at}.taxable`, 'I11-20');
      }
    }
    if (it.discount !== undefined && dec(it.discount).compare(dec(it.amount)) > 0) {
      add('NFCE_ITEM_DISCOUNT_EXCEEDS_AMOUNT', 'O desconto do item é maior que o valor do item.', `${at}.discount`);
    }
    for (const [name, value] of [['pis', it.pis], ['cofins', it.cofins]] as const) {
      if (value?.group !== 'OTHER') continue;
      const byValue = value.base !== undefined && value.rate !== undefined && value.quantityBase === undefined && value.ratePerUnit === undefined;
      const byQuantity = value.quantityBase !== undefined && value.ratePerUnit !== undefined && value.base === undefined && value.rate === undefined;
      if (!byValue && !byQuantity) {
        add('NFCE_CONTRIBUTION_OTHER_BASIS', `${name}: informe base e rate, ou quantityBase e ratePerUnit (escolha do grupo ${name.toUpperCase()}Outr no leiaute).`, `${at}.${name}`);
      }
    }
  });

  if (sale.consumer !== undefined && 'cnpj' in sale.consumer.document && sale.consumer.document.cnpj === issuer.cnpj) {
    add('NFCE_CONSUMER_IS_ISSUER', 'O destinatário não pode ser o próprio emitente.', 'consumer.document', 'E02-20');
  }

  sale.payments.forEach((p, index) => {
    const at = `payments[${String(index)}]`;
    const refused = REFUSED_PAYMENT_METHODS[p.method];
    if (refused !== undefined) add('NFCE_PAYMENT_METHOD_REFUSED', `Forma de pagamento ${p.method} não é aceita na NFC-e.`, `${at}.method`, refused);
    if (CARD_REQUIRED.has(p.method) && p.card === undefined) {
      add('NFCE_PAYMENT_CARD_REQUIRED', `Pagamento ${p.method} (cartão ou PIX) exige o grupo card.`, `${at}.card`, 'YA04-10');
    }
  });

  const totals = saleTotals(sale);
  if (totals.invoice.isNegative() || totals.invoice.isZero()) {
    add('NFCE_TOTAL_NOT_POSITIVE', 'O valor total da nota precisa ser maior que zero.', 'items');
  }
  if (totals.paid.compare(totals.invoice) < 0) {
    add('NFCE_PAYMENTS_BELOW_TOTAL', `Pagamentos (${totals.paid.toString()}) menores que o total da nota (${totals.invoice.toString()}).`, 'payments', 'YA03-10');
  }
  return issues;
}
