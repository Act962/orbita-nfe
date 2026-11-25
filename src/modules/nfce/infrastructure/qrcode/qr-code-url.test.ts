import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAccessKey } from '../../domain/access-key.js';
import { digestValueHex, hashWithCsc, PI_QR_CODE_URL, QrCodeError, qrCodeV2Offline, qrCodeV2Online, qrCodeV3Offline, qrCodeV3Online } from './qr-code-url.js';

/**
 * QR Code da NFC-e (ADR-0066).
 * - Hash da versão 2.00: os exemplos resolvidos do Manual do DANFE NFC-e v6.0 (4.3.6.1 e 4.3.6.2).
 *   As chaves desses exemplos são hipotéticas e têm DV inválido (calculado 8 e 3, impresso 4), por
 *   isso o hash é conferido à parte e a URL só sai com chave válida.
 * - URLs: chave FICTÍCIA montada pelo motor.
 */
const BASE = 'http://www.sefazexemplo.gov.br/nfce/qrcode';
/** CSC hipotético do manual (41 caracteres, com hífens): só para conferir o hash com os exemplos. */
const MANUAL_CSC = { secret: 'SEU-CODIGO-CSC-CONTRIBUINTE-36-CARACTERES' };
/** CSC FICTÍCIO no formato do item 4.3.3 (alfanumérico, 16 a 36). */
const CSC = { id: '1', secret: 'CSCFICTICIO0123456789ABCDEFGHIJKLMN' };
const built = buildAccessKey({ cUF: '22', yearMonth: '2611', cnpj: '11222333000181', model: '65', series: 1, number: 1, emissionType: '1', numericCode: '10000001' });
if (!built.ok) throw new Error('chave de teste inválida');
const KEY = built.value.value;

describe('QR Code versão 2.00 (com CSC)', () => {
  it('hash online: o exemplo 4.3.6.1 do manual (DC6AE2C2…)', () => {
    expect(hashWithCsc('28170800156225000131650110000151341562040824|2|1|1', MANUAL_CSC)).toBe('DC6AE2C2B9A992BE59679AC365E29922DE6B7511');
  });

  it('hash off-line: o exemplo 4.3.6.2 do manual (digVal em hexadecimal, 4615A93B…)', () => {
    const hex = digestValueHex('yzGYhUx1/XYYzksWB+fPR3Qc50c=');
    expect(hex).toBe('797a4759685578312f5859597a6b7357422b6650523351633530633d');
    expect(hashWithCsc(`28170800156225000131650110000151349562040824|2|1|02|60.90|${hex}|1`, MANUAL_CSC)).toBe('4615A93BB0D7C4E780F8D30EE77EDD5BA55C7D66');
  });

  it('URLs online e off-line na ordem das tabelas 2 e 3, com o hash no fim', () => {
    const online = qrCodeV2Online({ baseUrl: PI_QR_CODE_URL, accessKey: KEY, environment: '2', csc: CSC });
    expect(online).toBe(`http://www.sefaz.pi.gov.br/nfce/qrcode?p=${KEY}|2|2|1|${hashWithCsc(`${KEY}|2|2|1`, CSC)}`);
    expect(online).not.toContain(CSC.secret);
    const offline = qrCodeV2Offline({ baseUrl: BASE, accessKey: KEY, environment: '2', issueDay: '02', totalAmount: '60.90', digestValueBase64: 'yzGYhUx1/XYYzksWB+fPR3Qc50c=', csc: CSC });
    const params = `${KEY}|2|2|02|60.90|${digestValueHex('yzGYhUx1/XYYzksWB+fPR3Qc50c=')}|1`;
    expect(offline).toBe(`${BASE}?p=${params}|${hashWithCsc(params, CSC)}`);
  });

  it('formatos fora do manual são recusados', () => {
    const base = { baseUrl: BASE, accessKey: KEY, environment: '1' as const };
    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'OK';
      } catch (error) {
        return error instanceof QrCodeError ? error.code : 'OTHER';
      }
    };
    expect(code(() => qrCodeV2Online({ ...base, csc: { id: '01', secret: CSC.secret } }))).toBe('QR_INVALID_CSC_ID');
    expect(code(() => qrCodeV2Online({ ...base, csc: { id: '1', secret: 'CURTO' } }))).toBe('QR_INVALID_CSC');
    expect(code(() => qrCodeV2Online({ ...base, csc: { id: '1', secret: MANUAL_CSC.secret } }))).toBe('QR_INVALID_CSC');
    expect(code(() => qrCodeV2Online({ ...base, accessKey: '28170800156225000131650110000151341562040824', csc: CSC }))).toBe('QR_INVALID_ACCESS_KEY');
    const digest = 'yzGYhUx1/XYYzksWB+fPR3Qc50c=';
    expect(code(() => qrCodeV2Offline({ ...base, issueDay: '2', totalAmount: '60.90', digestValueBase64: digest, csc: CSC }))).toBe('QR_INVALID_DAY');
    expect(code(() => qrCodeV2Offline({ ...base, issueDay: '02', totalAmount: '1.234,56', digestValueBase64: digest, csc: CSC }))).toBe('QR_INVALID_TOTAL');
    expect(code(() => qrCodeV2Offline({ ...base, issueDay: '02', totalAmount: '60.90', digestValueBase64: 'curto', csc: CSC }))).toBe('QR_INVALID_DIGEST');
  });
});

describe('QR Code versão 3.00 (sem CSC)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const base = { baseUrl: BASE, accessKey: KEY, environment: '2' as const, issueDay: '02', totalAmount: '60.90' };

  it('online: chave|3|tpAmb', () => {
    expect(qrCodeV3Online(base)).toBe(`${BASE}?p=${KEY}|3|2`);
  });

  it('off-line: parâmetros 1 a 7 assinados em RSA-SHA1 (Base64), conferível com a chave pública', () => {
    const url = qrCodeV3Offline({ ...base, recipient: { kind: 'CPF', value: '12345678909' }, privateKey });
    const p = url.slice(url.indexOf('?p=') + 3);
    const signed = p.slice(0, p.lastIndexOf('|'));
    expect(signed).toBe(`${KEY}|3|2|02|60.90|2|12345678909`);
    expect(createVerify('RSA-SHA1').update(signed, 'utf8').verify(publicKey, p.slice(p.lastIndexOf('|') + 1), 'base64')).toBe(true);
  });

  it('destinatário não identificado ou estrangeiro: campos vazios entre os separadores (tabela 7)', () => {
    expect(qrCodeV3Offline({ ...base, privateKey })).toContain('|02|60.90|||');
    expect(qrCodeV3Offline({ ...base, recipient: { kind: 'FOREIGN' }, privateKey })).toContain('|02|60.90|3||');
  });
});
