import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadFiscalSchemas } from '../../../../main/fiscal-resources.js';
import { SIGNATURE_PROFILES, signEnveloped, verifyEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import { createTestPki } from '../../../../../test/support/tls-test-pki.js';
import { buildAccessKey } from '../../domain/access-key.js';
import { checkConsumerSale, saleTotals, type ConsumerSale, type SaleIssuer } from '../../domain/consumer-sale.js';
import { consumerSaleSchema } from '../../presentation/http/consumer-sale-schema.js';
import { PI_QR_CODE_URL, qrCodeV3Online } from '../qrcode/qr-code-url.js';
import { buildNfceXml, finishNfceXml, type NfceIssuerData } from './nfce-xml.js';

/** Dados FICTÍCIOS. A URL de consulta é um marcador: a `urlChave` do PI ainda está a confirmar. */
const CNPJ = '11222333000181';
const CONSULTATION_URL = 'https://consulta.exemplo.invalid/nfce';
const ISSUER: NfceIssuerData = {
  cnpj: CNPJ,
  name: 'EMPRESA FICTICIA LTDA',
  address: {
    street: 'RUA TESTE',
    number: '100',
    district: 'CENTRO',
    municipalityCode: '2211001',
    municipalityName: 'TERESINA',
    uf: 'PI',
    postalCode: '64000000',
  },
  stateRegistration: '123456789',
  taxRegime: '1',
};

const SALE = {
  externalReference: 'venda-1',
  operationNature: 'VENDA',
  presence: 'IN_PERSON',
  consumer: { document: { cpf: '12345678909' }, name: 'CONSUMIDOR TESTE' },
  items: [
    {
      code: 'P1',
      gtin: null,
      description: 'PRODUTO TESTE & CIA',
      ncm: '39241000',
      cfop: '5102',
      unit: 'UN',
      quantity: '3',
      unitPrice: '3.3333',
      amount: '10.00',
      discount: '1.00',
      icms: { csosn: '102', origin: '0' },
      pis: { group: 'OTHER', cst: '49', base: '0.00', rate: '0.00', amount: '0.00' },
      cofins: { group: 'OTHER', cst: '49', base: '0.00', rate: '0.00', amount: '0.00' },
      approximateTaxes: '1.50',
    },
    {
      code: 'P2',
      gtin: '7891234567895',
      description: 'PRODUTO COM ST',
      ncm: '22021000',
      cest: '0300700',
      cfop: '5405',
      unit: 'UN',
      quantity: '2',
      unitPrice: '5.25',
      amount: '10.50',
      icms: { csosn: '500', origin: '0', stRetained: { base: '12.00', consumerRate: '18.00', amount: '0.50' } },
      pis: { group: 'NOT_TAXED', cst: '04' },
      cofins: { group: 'NOT_TAXED', cst: '04' },
    },
  ],
  payments: [
    { method: '01', amount: '15.00' },
    { method: '17', amount: '5.00', card: { integration: '2' } },
  ],
  additionalInfo: 'Obrigado pela preferencia',
} as const;

function parse(sale: unknown): ConsumerSale {
  return consumerSaleSchema.parse(sale);
}

function assemble(sale: ConsumerSale): { xml: string; certificatePem: string } {
  const key = buildAccessKey({ cUF: '22', yearMonth: '2611', cnpj: CNPJ, model: '65', series: 1, number: 42, emissionType: '1', numericCode: '48213957' });
  if (!key.ok) throw new Error('chave');
  const unsigned = buildNfceXml({
    accessKey: key.value,
    cUF: '22',
    numericCode: '48213957',
    series: 1,
    number: 42,
    issuedAt: '2026-11-26T10:00:00-03:00',
    tpAmb: '2',
    appVersion: 'orbita-nfe-0.1.0',
    issuer: ISSUER,
    sale,
  });
  const pki = createTestPki();
  const signed = signEnveloped({ xml: unsigned, elementLocalName: 'infNFe', privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem, profile: SIGNATURE_PROFILES.nfe400 });
  const qrCode = qrCodeV3Online({ baseUrl: PI_QR_CODE_URL, accessKey: key.value.value, environment: '2' });
  return { xml: finishNfceXml(signed, { qrCode, consultationUrl: CONSULTATION_URL }), certificatePem: pki.client.certPem };
}

describe('XML da NFC-e v1 (ADR-0069)', () => {
  it('venda do Simples (CSOSN 102 e 500) monta, assina e passa no XSD do PL_010h', async () => {
    const sale = parse(SALE);
    expect(checkConsumerSale(sale, { cnpj: CNPJ, taxRegime: '1' })).toEqual([]);
    const { xml, certificatePem } = assemble(sale);

    const result = await loadFiscalSchemas().validate('nfe/4.00-nfe-pl010h', 'nfe_v4.00.xsd', xml);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(verifyEnveloped(xml, certificatePem, SIGNATURE_PROFILES.nfe400)).toEqual({ valid: true });

    // Valores fixos do modelo 65, cada um com a regra que o impõe.
    for (const fixed of ['<mod>65</mod>', '<tpNF>1</tpNF>', '<idDest>1</idDest>', '<tpImp>4</tpImp>', '<finNFe>1</finNFe>', '<indFinal>1</indFinal>', '<indPres>1</indPres>', '<indIEDest>9</indIEDest>', '<modFrete>9</modFrete>']) {
      expect(xml).toContain(fixed);
    }
    expect(xml).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(xml).toContain('PRODUTO TESTE &amp; CIA');
    // Totais: vProd 20.50, vDesc 1.00, vNF 19.50, pagos 20.00, troco 0.50.
    expect(xml).toContain('<vProd>20.50</vProd>');
    expect(xml).toContain('<vNF>19.50</vNF>');
    expect(xml).toContain('<vTroco>0.50</vTroco>');
    expect(xml).toContain('<vTotTrib>1.50</vTotTrib>');
    // infNFeSupl fica entre infNFe e Signature.
    expect(xml.indexOf('</infNFe><infNFeSupl>')).toBeGreaterThan(0);
    expect(xml.indexOf('</infNFeSupl><Signature')).toBeGreaterThan(0);
  });

  it('venda mínima: sem consumidor, sem PIS/COFINS, um pagamento exato', async () => {
    const sale = parse({
      operationNature: 'VENDA',
      presence: 'IN_PERSON_OFF_PREMISES',
      items: [{ code: 'A', gtin: null, description: 'ITEM', ncm: '39241000', cfop: '5102', unit: 'UN', quantity: '1', unitPrice: '7.9', amount: '7.90', icms: { csosn: '400', origin: '0' } }],
      payments: [{ method: '01', amount: '7.90' }],
    });
    expect(checkConsumerSale(sale, { cnpj: CNPJ, taxRegime: '1' })).toEqual([]);
    const { xml } = assemble(sale);
    const result = await loadFiscalSchemas().validate('nfe/4.00-nfe-pl010h', 'nfe_v4.00.xsd', xml);
    expect(result.errors).toEqual([]);
    expect(xml).not.toContain('<dest>');
    expect(xml).not.toContain('<vTroco>');
    expect(xml).toContain('<indPres>5</indPres>');
  });

  it('totais exatos, sem arredondar (W07, W10, W16-10, YA09-10)', () => {
    const totals = saleTotals(parse(SALE));
    expect(totals.products.toFixed(2)).toBe('20.50');
    expect(totals.discount.toFixed(2)).toBe('1.00');
    expect(totals.invoice.toFixed(2)).toBe('19.50');
    expect(totals.change?.toFixed(2)).toBe('0.50');
  });
});

describe('aceite da venda (regras do modelo 65)', () => {
  const issuer: SaleIssuer = { cnpj: CNPJ, taxRegime: '1' };
  const codes = (sale: unknown, who: SaleIssuer = issuer) => checkConsumerSale(parse(sale), who).map((i) => [i.code, i.ruleId]);
  const withItem = (patch: object) => ({ ...SALE, items: [{ ...SALE.items[0], ...patch }], payments: [{ method: '01', amount: '100.00' }] });

  it('CFOP fora da lista do CSOSN → N12a-40 / N12a-44', () => {
    expect(codes(withItem({ cfop: '5405' }))).toEqual([['NFCE_CFOP_NOT_ALLOWED_FOR_CSOSN', 'N12a-40']]);
    expect(codes(withItem({ cfop: '5102', icms: { csosn: '500', origin: '0' } }))).toEqual([['NFCE_CFOP_NOT_ALLOWED_FOR_CSOSN', 'N12a-44']]);
  });

  it('CSOSN fora da NFC-e (101, 201, 900) nem passa no contrato', () => {
    for (const csosn of ['101', '201', '202', '900']) {
      expect(consumerSaleSchema.safeParse(withItem({ icms: { csosn, origin: '0' } })).success).toBe(false);
    }
  });

  it('valor do item diferente de quantidade × preço além de R$ 0,01 → I11-10', () => {
    // 3 × 3.3333 = 9.9999: 10.00 está dentro da tolerância; 10.01 fica a 0.0101.
    expect(codes(withItem({ amount: '10.00' }))).toEqual([]);
    expect(codes(withItem({ amount: '10.01' }))).toEqual([['NFCE_ITEM_AMOUNT_MISMATCH', 'I11-10']]);
  });

  it('pagamentos recusados no modelo 65 e cartão/PIX sem o grupo card', () => {
    const base = { ...SALE, payments: [{ method: '14', amount: '19.50' }, { method: '03', amount: '1.00' }] };
    expect(codes(base)).toEqual([
      ['NFCE_PAYMENT_METHOD_REFUSED', 'YA02-10'],
      ['NFCE_PAYMENT_CARD_REQUIRED', 'YA04-10'],
    ]);
  });

  it('pagamentos menores que o total → YA03-10', () => {
    expect(codes({ ...SALE, payments: [{ method: '01', amount: '19.49' }] })).toEqual([['NFCE_PAYMENTS_BELOW_TOTAL', 'YA03-10']]);
  });

  it('emitente fora do Simples não emite na v1; destinatário igual ao emitente → E02-20', () => {
    expect(codes(SALE, { cnpj: CNPJ, taxRegime: '3' })).toEqual([['NFCE_REGIME_NOT_SUPPORTED', undefined]]);
    expect(codes({ ...SALE, consumer: { document: { cnpj: CNPJ } } })).toEqual([['NFCE_CONSUMER_IS_ISSUER', 'E02-20']]);
  });

  it('PIS/COFINS "Outros" exige base+alíquota ou quantidade+valor por unidade', () => {
    expect(codes(withItem({ pis: { group: 'OTHER', cst: '99', amount: '0.00' } }))).toEqual([['NFCE_CONTRIBUTION_OTHER_BASIS', undefined]]);
  });

  it('campos fora do contrato v1 são recusados (strict)', () => {
    expect(consumerSaleSchema.safeParse({ ...SALE, delivery: {} }).success).toBe(false);
    expect(consumerSaleSchema.safeParse({ ...SALE, presence: 'DELIVERY' }).success).toBe(false);
    expect(consumerSaleSchema.safeParse(withItem({ amount: '10.5' })).success).toBe(false); // TDec_1302 exige 2 casas
  });
});
