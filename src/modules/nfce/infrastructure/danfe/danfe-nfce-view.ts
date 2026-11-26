import type { Element } from '@xmldom/xmldom';
import { parseUntrustedXml } from '../../../../shared/infrastructure/xml/untrusted-xml.js';
import { NFE_NS } from '../sefaz/sefaz-soap.js';

/**
 * Leitura do `nfeProc` para o DANFE NFC-e (ADR-0076), pelo "Manual de Especificações Técnicas do
 * DANFE NFC-e e QR Code", versão 6.0 (março de 2025), capítulos 2 e 3 (divisões I a IX).
 *
 * Regra do manual (cap. 2): "No DANFE NFC-e não devem ser inseridas informações que não constem do
 * respectivo arquivo eletrônico XML da NFC-e, exceto as informações do XML de retorno da
 * autorização". Por isso tudo aqui vem do `nfeProc`: nada do cadastro nem da venda gravada.
 */

/** tPag: tabela do MOC 7.0, Anexo I, campo YA02 (atualizada na NT 2016.002 e na NT 2020.006). */
const PAYMENT_METHODS: Readonly<Record<string, string>> = {
  '01': 'Dinheiro',
  '02': 'Cheque',
  '03': 'Cartão de Crédito',
  '04': 'Cartão de Débito',
  '05': 'Crédito Loja',
  '10': 'Vale Alimentação',
  '11': 'Vale Refeição',
  '12': 'Vale Presente',
  '13': 'Vale Combustível',
  '15': 'Boleto Bancário',
  '16': 'Depósito Bancário',
  '17': 'Pagamento Instantâneo (PIX)',
  '18': 'Transferência bancária, Carteira Digital',
  '19': 'Programa de fidelidade, Cashback, Crédito Virtual',
  '90': 'Sem pagamento',
  '99': 'Outros',
};

export interface DanfeNfceView {
  /** Divisão I. */
  readonly issuer: { readonly document: string; readonly name: string; readonly address: string };
  /** Divisão II. */
  readonly items: readonly { readonly code: string; readonly description: string; readonly quantity: string; readonly unit: string; readonly unitPrice: string; readonly total: string }[];
  /** Divisão III. */
  readonly totals: {
    readonly itemCount: number;
    readonly products: string;
    /** Frete + seguro + outras despesas; nulo quando zero (a linha só aparece se houver). */
    readonly additions: string | null;
    readonly discount: string | null;
    /** Só quando há acréscimo ou desconto. */
    readonly amountDue: string | null;
    readonly payments: readonly { readonly method: string; readonly amount: string }[];
    readonly change: string | null;
  };
  /** Divisão IV. */
  readonly consultation: { readonly url: string; readonly accessKey: string };
  /** Divisão V: o texto do QR Code, como está no XML. */
  readonly qrCode: string;
  /** Divisão VI. */
  readonly consumer: readonly string[];
  /** Divisão VII. */
  readonly identification: { readonly number: string; readonly series: string; readonly issuedAt: string; readonly protocol: string | null };
  /** Divisão VIII. */
  readonly fiscalMessages: readonly string[];
  /** Divisão IX. */
  readonly taxpayerMessages: readonly string[];
}

export class DanfeNfceError extends Error {
  constructor(readonly code: 'DANFE_NFCE_XML_INVALID' | 'DANFE_NFCE_NOT_AUTHORIZED') {
    super(code);
    this.name = 'DanfeNfceError';
  }
}

/** Fuso de impressão: horário local do emitente (manual 3.1.7). Só o PI (-03:00) neste projeto. */
const LOCAL_OFFSET_MINUTES = -180;

export function danfeNfceView(nfeProcXml: string): DanfeNfceView {
  let root: Element;
  try {
    const doc = parseUntrustedXml(nfeProcXml);
    if (doc.documentElement?.namespaceURI !== NFE_NS || doc.documentElement.localName !== 'nfeProc') throw new Error('raiz');
    root = doc.documentElement;
  } catch {
    throw new DanfeNfceError('DANFE_NFCE_XML_INVALID');
  }
  const first = (parent: Element, name: string): Element | undefined => parent.getElementsByTagNameNS(NFE_NS, name)[0];
  const text = (parent: Element | undefined, name: string): string | undefined => (parent === undefined ? undefined : first(parent, name)?.textContent?.trim());
  const need = (parent: Element | undefined, name: string): string => {
    const value = text(parent, name);
    if (value === undefined || value === '') throw new DanfeNfceError('DANFE_NFCE_XML_INVALID');
    return value;
  };

  const infNFe = first(root, 'infNFe');
  const ide = infNFe === undefined ? undefined : first(infNFe, 'ide');
  const emit = infNFe === undefined ? undefined : first(infNFe, 'emit');
  const ender = emit === undefined ? undefined : first(emit, 'enderEmit');
  const total = infNFe === undefined ? undefined : first(infNFe, 'ICMSTot');
  const supl = first(root, 'infNFeSupl');
  const infProt = first(root, 'infProt');
  if (infNFe === undefined || ide === undefined || emit === undefined || ender === undefined || total === undefined || supl === undefined) {
    throw new DanfeNfceError('DANFE_NFCE_XML_INVALID');
  }
  const cStat = text(infProt, 'cStat');
  if (cStat !== '100' && cStat !== '150') throw new DanfeNfceError('DANFE_NFCE_NOT_AUTHORIZED');

  const cnpj = text(emit, 'CNPJ');
  const cpf = text(emit, 'CPF');
  const issuerDocument = cnpj !== undefined ? `CNPJ: ${formatCnpj(cnpj)}` : `CPF: ${formatCpf(cpf ?? '')}`;
  const address = [
    [need(ender, 'xLgr'), need(ender, 'nro'), text(ender, 'xCpl')].filter((p) => p !== undefined && p !== '').join(', '),
    need(ender, 'xBairro'),
    `${need(ender, 'xMun')} - ${need(ender, 'UF')}`,
  ].join(' - ');

  const items = Array.from(infNFe.getElementsByTagNameNS(NFE_NS, 'det')).map((det) => {
    const prod = first(det, 'prod');
    return {
      code: need(prod, 'cProd'),
      description: need(prod, 'xProd'),
      quantity: decimalBr(need(prod, 'qCom')),
      unit: need(prod, 'uCom'),
      unitPrice: decimalBr(need(prod, 'vUnCom')),
      total: moneyBr(need(prod, 'vProd')),
    };
  });

  const cents = (name: string): number => Math.round(Number(text(total, name) ?? '0') * 100);
  const additions = cents('vFrete') + cents('vSeg') + cents('vOutro');
  const discount = cents('vDesc');
  const pag = first(infNFe, 'pag');
  const payments = pag === undefined ? [] : Array.from(pag.getElementsByTagNameNS(NFE_NS, 'detPag')).map((p) => {
    const code = need(p, 'tPag');
    return { method: PAYMENT_METHODS[code] ?? text(p, 'xPag') ?? `Forma de pagamento ${code}`, amount: moneyBr(text(p, 'vPag') ?? '0') };
  });
  const change = text(pag, 'vTroco');

  const dest = first(infNFe, 'dest');
  const consumer: string[] = [];
  if (dest === undefined) {
    consumer.push('CONSUMIDOR NÃO IDENTIFICADO');
  } else {
    const destCnpj = text(dest, 'CNPJ');
    const destCpf = text(dest, 'CPF');
    const foreign = text(dest, 'idEstrangeiro');
    if (destCnpj !== undefined) consumer.push(`CONSUMIDOR CNPJ: ${formatCnpj(destCnpj)}`);
    else if (destCpf !== undefined) consumer.push(`CONSUMIDOR CPF: ${formatCpf(destCpf)}`);
    else if (foreign !== undefined) consumer.push(`CONSUMIDOR Id. Estrangeiro: ${foreign}`);
    const name = text(dest, 'xNome');
    if (name !== undefined) consumer.push(name);
  }

  const nProt = text(infProt, 'nProt');
  const dhRecbto = text(infProt, 'dhRecbto');
  const fiscalMessages: string[] = [];
  if (need(ide, 'tpAmb') === '2') fiscalMessages.push('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL');
  const infAdFisco = text(infNFe, 'infAdFisco');
  if (infAdFisco !== undefined) fiscalMessages.push(infAdFisco);

  const taxpayerMessages: string[] = [];
  const infCpl = text(infNFe, 'infCpl');
  if (infCpl !== undefined) taxpayerMessages.push(infCpl);
  const vTotTrib = text(total, 'vTotTrib');
  // Manual 3.1.9.1: a critério do emissor, o valor aproximado dos tributos (Lei 12.741/2012).
  if (vTotTrib !== undefined) taxpayerMessages.push(`Valor aproximado dos tributos (Lei Federal 12.741/2012): R$ ${moneyBr(vTotTrib)}`);

  const accessKey = (infNFe.getAttribute('Id') ?? '').replace(/^NFe/, '');
  return {
    issuer: { document: issuerDocument, name: need(emit, 'xNome'), address },
    items,
    totals: {
      itemCount: items.length,
      products: moneyBr(text(total, 'vProd') ?? '0'),
      additions: additions === 0 ? null : moneyBr((additions / 100).toFixed(2)),
      discount: discount === 0 ? null : moneyBr((discount / 100).toFixed(2)),
      amountDue: additions === 0 && discount === 0 ? null : moneyBr(need(total, 'vNF')),
      payments,
      change: change === undefined ? null : moneyBr(change),
    },
    consultation: { url: need(supl, 'urlChave'), accessKey: (accessKey.match(/.{1,4}/g) ?? []).join(' ') },
    qrCode: need(supl, 'qrCode'),
    consumer,
    identification: {
      number: need(ide, 'nNF'),
      series: need(ide, 'serie'),
      issuedAt: localDateTime(need(ide, 'dhEmi')),
      protocol: nProt === undefined ? null : `${nProt} ${dhRecbto === undefined ? '' : localDateTime(dhRecbto)}`.trim(),
    },
    fiscalMessages,
    taxpayerMessages,
  };
}

/** Valores com vírgula decimal e ponto de milhar (manual 3.1.2 e 3.1.3). */
export function moneyBr(value: string): string {
  const [int = '0', frac = '00'] = Number(value).toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${frac}`;
}

/** Quantidades e preços unitários: as casas do XML, com vírgula e ponto de milhar. */
export function decimalBr(value: string): string {
  const [int = '0', frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

const formatCnpj = (v: string): string => (v.length === 14 ? `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}` : v);
const formatCpf = (v: string): string => (v.length === 11 ? `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}` : v);

/** Data e hora do XML (com fuso) convertidas para o horário local do emitente (manual 3.1.7). */
export function localDateTime(value: string): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const local = new Date(at + LOCAL_OFFSET_MINUTES * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${String(local.getUTCFullYear())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}
