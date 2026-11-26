import { createPrivateKey } from 'node:crypto';
import { buildAccessKey } from '../../src/modules/nfce/domain/access-key.js';
import type { ConsumerSale } from '../../src/modules/nfce/domain/consumer-sale.js';
import { PI_QR_CODE_URL, qrCodeV3Online } from '../../src/modules/nfce/infrastructure/qrcode/qr-code-url.js';
import { buildNfceXml, finishNfceXml, type NfceIssuerData } from '../../src/modules/nfce/infrastructure/xml/nfce-xml.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../src/shared/infrastructure/xml/xml-signer.js';
import type { TestPki } from './tls-test-pki.js';

/**
 * NFC-e de TESTE: emitente, venda e chave FICTÍCIOS. A URL de consulta é um marcador `.invalid`
 * (a `urlChave` do PI ainda está a confirmar).
 */
export const TEST_ISSUER: NfceIssuerData = {
  cnpj: '11222333000181',
  name: 'EMPRESA FICTICIA LTDA',
  address: { street: 'RUA TESTE', number: '100', district: 'CENTRO', municipalityCode: '2211001', municipalityName: 'TERESINA', uf: 'PI', postalCode: '64000000' },
  stateRegistration: '123456789',
  taxRegime: '1',
};

export const MINIMAL_SALE: ConsumerSale = {
  operationNature: 'VENDA',
  presence: 'IN_PERSON',
  items: [{ code: 'A', gtin: null, description: 'ITEM', ncm: '39241000', cfop: '5102', unit: 'UN', quantity: '1', unitPrice: '7.90', amount: '7.90', icms: { csosn: '102', origin: '0' } }],
  payments: [{ method: '01', amount: '7.90' }],
};

export interface TestNfce {
  readonly xml: string;
  readonly accessKey: string;
  readonly digestValue: string;
}

/** Monta, assina (perfil nfe400) e completa uma NFC-e fictícia, como o worker fará. */
export function assembleTestNfce(pki: TestPki, sale: ConsumerSale = MINIMAL_SALE, number = 42): TestNfce {
  const key = buildAccessKey({ cUF: '22', yearMonth: '2611', cnpj: TEST_ISSUER.cnpj, model: '65', series: 1, number, emissionType: '1', numericCode: '48213957' });
  if (!key.ok) throw new Error('chave de teste inválida');
  const unsigned = buildNfceXml({
    accessKey: key.value,
    cUF: '22',
    numericCode: '48213957',
    series: 1,
    number,
    issuedAt: '2026-11-26T10:00:00-03:00',
    tpAmb: '2',
    appVersion: 'orbita-nfe-teste',
    issuer: TEST_ISSUER,
    sale,
  });
  const signed = signEnveloped({ xml: unsigned, elementLocalName: 'infNFe', privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem, profile: SIGNATURE_PROFILES.nfe400 });
  const qrCode = qrCodeV3Online({ baseUrl: PI_QR_CODE_URL, accessKey: key.value.value, environment: '2' });
  const xml = finishNfceXml(signed, { qrCode, consultationUrl: 'https://consulta.exemplo.invalid/nfce' });
  const digestValue = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xml)?.[1];
  if (digestValue === undefined) throw new Error('assinatura sem DigestValue');
  return { xml, accessKey: key.value.value, digestValue };
}
