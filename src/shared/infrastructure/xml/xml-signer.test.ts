import { beforeAll, describe, expect, it } from 'vitest';
import { createTestIcpPki, type TestIcpPki } from '../../../../test/support/icp-test-pki.js';
import { dpsId, minimalDps } from '../../../../test/support/dps-fixtures.js';
import { ForgePkcs12Reader } from '../../../modules/certificates/public.js';
import { ALGORITHMS, SIGNATURE_PROFILES, signEnveloped, verifyEnveloped, XmlSignatureError, type SignatureProfile } from './xml-signer.js';

const PASSWORD = 'CANARY-PASSWORD-7f3a91c2';
const PROFILE = SIGNATURE_PROFILES.nfseNacionalDps;
const SHA256_PROFILE: SignatureProfile = {
  id: 'teste-sha256',
  signatureAlgorithm: ALGORITHMS.rsaSha256,
  digestAlgorithm: ALGORITHMS.sha256,
  canonicalizationAlgorithm: ALGORITHMS.c14n10,
  transforms: [ALGORITHMS.envelopedSignature, ALGORITHMS.c14n10],
};

let pki: TestIcpPki;
let key: { privateKey: import('node:crypto').KeyObject; certificatePem: string };
let otherCertPem: string;

beforeAll(() => {
  pki = createTestIcpPki();
  const read = (cnpj: string) => {
    const result = new ForgePkcs12Reader().read({ pfx: pki.pfx({ cnpj, password: PASSWORD }), password: Buffer.from(PASSWORD) });
    if (!result.ok) throw new Error('PFX de teste ilegível');
    return result.value;
  };
  const opened = read('11222333000181');
  key = { privateKey: opened.privateKey, certificatePem: opened.certificatePem };
  otherCertPem = read('99888777000166').certificatePem;
});

const sign = (xml = minimalDps(), profile: SignatureProfile = PROFILE) =>
  signEnveloped({ xml, elementLocalName: 'infDPS', privateKey: key.privateKey, certificatePem: key.certificatePem, profile });

describe('signEnveloped (perfil nfse-nacional-dps)', () => {
  it('Signature sem prefixo, irmã de infDPS, referência ao Id e algoritmos do perfil', () => {
    const signed = sign();
    expect(signed).toContain('</infDPS><Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(signed).not.toContain('ds:Signature');
    expect(signed).toContain(`URI="#${dpsId('1', '1')}"`);
    expect(signed).toContain(`<SignatureMethod Algorithm="${ALGORITHMS.rsaSha1}"/>`);
    expect(signed).toContain(`<DigestMethod Algorithm="${ALGORITHMS.sha1}"/>`);
    expect(signed).toContain('<X509Certificate>');
    expect(signed.endsWith('</Signature></DPS>')).toBe(true);
  });

  it('verifica e detecta adulteração do conteúdo', () => {
    const signed = sign();
    expect(verifyEnveloped(signed, key.certificatePem, PROFILE)).toEqual({ valid: true });
    expect(verifyEnveloped(signed.replace('100.00', '900.00'), key.certificatePem, PROFILE)).toEqual({ valid: false, reason: 'SIGNATURE_INVALID' });
  });

  it('não confia no certificado embutido: outro certificado não verifica', () => {
    expect(verifyEnveloped(sign(), otherCertPem, PROFILE)).toEqual({ valid: false, reason: 'SIGNATURE_INVALID' });
  });

  it('assinatura válida com algoritmo fora do perfil é recusada', () => {
    const signed = sign(minimalDps(), SHA256_PROFILE);
    expect(verifyEnveloped(signed, key.certificatePem, SHA256_PROFILE)).toEqual({ valid: true });
    expect(verifyEnveloped(signed, key.certificatePem, PROFILE)).toEqual({ valid: false, reason: 'ALGORITHM_NOT_ALLOWED' });
  });

  it('sem assinatura, com duas ou com DOCTYPE: recusado', () => {
    const signed = sign();
    expect(verifyEnveloped(minimalDps(), key.certificatePem, PROFILE)).toEqual({ valid: false, reason: 'SIGNATURE_MISSING' });
    const sigStart = signed.indexOf('<Signature');
    const twice = signed.replace('</DPS>', `${signed.slice(sigStart, signed.indexOf('</DPS>'))}</DPS>`);
    expect(verifyEnveloped(twice, key.certificatePem, PROFILE)).toEqual({ valid: false, reason: 'SIGNATURE_MULTIPLE' });
    expect(verifyEnveloped(signed.replace('<DPS ', '<!DOCTYPE DPS><DPS '), key.certificatePem, PROFILE)).toEqual({ valid: false, reason: 'XML_REJECTED' });
  });

  it.each([
    ['alvo inexistente', minimalDps().replaceAll('infDPS', 'infOutro'), 'XML_SIGN_TARGET_NOT_FOUND'],
    ['alvo sem Id', minimalDps().replace(/ Id="[^"]+"/, ''), 'XML_SIGN_TARGET_WITHOUT_ID'],
    ['alvo repetido', minimalDps().replace('</DPS>', '<infDPS Id="x"/></DPS>'), 'XML_SIGN_TARGET_AMBIGUOUS'],
  ])('recusa assinar: %s', (_name, xml, code) => {
    expect(() => sign(xml)).toThrow(expect.objectContaining({ code }) as XmlSignatureError);
  });

  it('não assina de novo um documento já assinado', () => {
    expect(() => sign(sign())).toThrow(expect.objectContaining({ code: 'XML_ALREADY_SIGNED' }) as XmlSignatureError);
  });
});
