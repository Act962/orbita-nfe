import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleTestNfce, MINIMAL_SALE } from '../../../../../test/support/nfce-fixtures.js';
import { createTestPki, type TestPki } from '../../../../../test/support/tls-test-pki.js';
import type { ConsumerSale } from '../../domain/consumer-sale.js';
import { SimulatedNfceAuthorizer } from '../sefaz/simulated-authorizer.js';
import { buildNfeProc } from '../xml/nfce-preparer.js';
import { renderDanfeNfce } from './danfe-nfce-pdf.js';
import { DanfeNfceError, danfeNfceView, decimalBr, localDateTime, moneyBr } from './danfe-nfce-view.js';

/** DANFE NFC-e (ADR-0076) a partir de um nfeProc FICTÍCIO: NFe assinada + protocolo do simulador. */
const FULL_SALE: ConsumerSale = {
  operationNature: 'VENDA',
  presence: 'IN_PERSON',
  consumer: { document: { cpf: '12345678909' }, name: 'CONSUMIDOR TESTE' },
  items: [
    { code: 'P1', gtin: null, description: 'PRODUTO TESTE', ncm: '39241000', cfop: '5102', unit: 'UN', quantity: '1500', unitPrice: '1.10', amount: '1650.00', discount: '50.00', icms: { csosn: '102', origin: '0' }, approximateTaxes: '120.00' },
    { code: 'P2', gtin: null, description: 'OUTRO PRODUTO', ncm: '39241000', cfop: '5102', unit: 'KG', quantity: '0.755', unitPrice: '20.00', amount: '15.10', icms: { csosn: '400', origin: '0' } },
  ],
  payments: [
    { method: '01', amount: '1000.00' },
    { method: '17', amount: '700.00', card: { integration: '2' } },
  ],
  additionalInfo: 'Obrigado pela preferencia',
};

let pki: TestPki;

async function nfeProc(sale: ConsumerSale, number: number): Promise<string> {
  const nfce = assembleTestNfce(pki, sale, number);
  const submitted = await new SimulatedNfceAuthorizer(() => new Date('2026-11-26T13:00:05Z')).submit(nfce.xml, { accessKey: nfce.accessKey, digestValue: nfce.digestValue });
  if (submitted.kind !== 'AUTHORIZED') throw new Error('simulador não autorizou');
  return buildNfeProc(nfce.xml, submitted.protocolXml);
}

beforeAll(() => {
  pki = createTestPki();
});

describe('leitura do nfeProc para o DANFE NFC-e (manual v6.0, divisões I a IX)', () => {
  it('venda mínima: cabeçalho, item, totais, consulta, consumidor não identificado, homologação', async () => {
    const view = danfeNfceView(await nfeProc(MINIMAL_SALE, 42));
    expect(view.issuer).toEqual({ document: 'CNPJ: 11.222.333/0001-81', name: 'EMPRESA FICTICIA LTDA', address: 'RUA TESTE, 100 - CENTRO - TERESINA - PI' });
    expect(view.items).toEqual([{ code: 'A', description: 'ITEM', quantity: '1', unit: 'UN', unitPrice: '7,90', total: '7,90' }]);
    expect(view.totals).toEqual({ itemCount: 1, products: '7,90', additions: null, discount: null, amountDue: null, payments: [{ method: 'Dinheiro', amount: '7,90' }], change: null });
    expect(view.consultation.url).toBe('https://consulta.exemplo.invalid/nfce');
    expect(view.consultation.accessKey).toMatch(/^(\d{4} ){10}\d{4}$/); // 11 blocos de 4
    expect(view.consumer).toEqual(['CONSUMIDOR NÃO IDENTIFICADO']);
    expect(view.identification).toEqual({ number: '42', series: '1', issuedAt: '26/11/2026 10:00:00', protocol: '900000000000001 26/11/2026 10:00:05' });
    expect(view.fiscalMessages).toEqual(['EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL']);
    expect(view.qrCode).toContain('?p=');
  });

  it('desconto, duas formas de pagamento, troco, consumidor com CPF e Lei 12.741', async () => {
    const view = danfeNfceView(await nfeProc(FULL_SALE, 43));
    expect(view.totals).toMatchObject({
      itemCount: 2,
      products: '1.665,10',
      discount: '50,00',
      amountDue: '1.615,10',
      payments: [
        { method: 'Dinheiro', amount: '1.000,00' },
        { method: 'Pagamento Instantâneo (PIX)', amount: '700,00' },
      ],
      change: '84,90',
    });
    expect(view.items[0]).toMatchObject({ quantity: '1.500', unitPrice: '1,10', total: '1.650,00' });
    expect(view.items[1]).toMatchObject({ quantity: '0,755', unit: 'KG' });
    expect(view.consumer).toEqual(['CONSUMIDOR CPF: 123.456.789-09', 'CONSUMIDOR TESTE']);
    expect(view.taxpayerMessages).toEqual(['Obrigado pela preferencia', 'Valor aproximado dos tributos (Lei Federal 12.741/2012): R$ 120,00']);
  });

  it('protocolo sem autorização (ou XML de outra coisa) não vira DANFE', async () => {
    const authorized = await nfeProc(MINIMAL_SALE, 44);
    expect(() => danfeNfceView(authorized.replace('<cStat>100</cStat>', '<cStat>301</cStat>'))).toThrow(DanfeNfceError);
    expect(() => danfeNfceView('<outro/>')).toThrow(DanfeNfceError);
  });

  it('formatos: vírgula decimal, ponto de milhar, horário local do PI', () => {
    expect(moneyBr('1234567.5')).toBe('1.234.567,50');
    expect(decimalBr('1234.0050')).toBe('1.234,0050');
    expect(localDateTime('2026-11-26T13:00:05-00:00')).toBe('26/11/2026 10:00:05');
    expect(localDateTime('2026-11-26T10:00:00-03:00')).toBe('26/11/2026 10:00:00');
  });
});

describe('PDF do DANFE NFC-e', () => {
  it('uma página de 80 mm de largura, com a altura do conteúdo', async () => {
    const pdfBytes = await renderDanfeNfce(danfeNfceView(await nfeProc(FULL_SALE, 45)));
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo((80 * 72) / 25.4, 1);
    expect(page.getHeight()).toBeGreaterThan(page.getWidth());
    // Amostra para conferência visual (fora do git).
    const out = resolve(import.meta.dirname, '../../../../../.local/danfe-nfce');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'amostra.pdf'), pdfBytes);
  });
});
