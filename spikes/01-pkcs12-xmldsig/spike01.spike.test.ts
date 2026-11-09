import { createSecureContext } from 'node:tls';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../support/test-pki.js';
import { hasDocker, hasOpenssl, opensslPfx, xmlsec1Verify } from '../support/external-tools.js';
import { openPkcs12, Pkcs12Error } from './pkcs12.js';
import { ALGORITHMS, signEnveloped, verifyEnveloped, type SignatureProfile } from './xml-signer.js';

const PASSWORD = 'CANARY-PASSWORD-7f3a91c2';
const NS = 'http://www.sped.fazenda.gov.br/nfse';

// XML ILUSTRATIVO (estrutura simplificada, não é o leiaute oficial da DPS).
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NS}" versao="1.01"><infDPS Id="DPS221100621122233300018100001000000000000001"><tpAmb>2</tpAmb><dhEmi>2026-11-09T10:00:00-03:00</dhEmi><xDescServ>Servico de teste com acentuação e &amp; especiais</xDescServ></infDPS></DPS>`;

const PROFILES: Record<string, SignatureProfile> = {
  'RSA-SHA1 / C14N 1.0': {
    signatureAlgorithm: ALGORITHMS.rsaSha1,
    digestAlgorithm: ALGORITHMS.sha1,
    canonicalizationAlgorithm: ALGORITHMS.c14n10,
    transforms: [ALGORITHMS.envelopedSignature, ALGORITHMS.c14n10],
  },
  'RSA-SHA256 / C14N 1.0': {
    signatureAlgorithm: ALGORITHMS.rsaSha256,
    digestAlgorithm: ALGORITHMS.sha256,
    canonicalizationAlgorithm: ALGORITHMS.c14n10,
    transforms: [ALGORITHMS.envelopedSignature, ALGORITHMS.c14n10],
  },
};

let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});

describe('Spike 01 — PKCS#12', () => {
  it.each(['3des', 'aes256'] as const)('abre PFX gerado em memória (%s) e casa chave com certificado', (algorithm) => {
    const opened = openPkcs12(pki.pfx(pki.client, PASSWORD, algorithm), PASSWORD);
    expect(opened.certificate.subject).toContain('EMPRESA FICTICIA LTDA:11222333000181');
    expect(opened.certificate.checkPrivateKey(opened.privateKey)).toBe(true);
    expect(opened.chainPem.length).toBe(1);
  });

  it('senha errada → PKCS12_INVALID_PASSWORD, sem a senha na mensagem', () => {
    const pfx = pki.pfx(pki.client, PASSWORD, 'aes256');
    let error: unknown;
    try {
      openPkcs12(pfx, 'senha-errada');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Pkcs12Error);
    expect((error as Pkcs12Error).code).toBe('PKCS12_INVALID_PASSWORD');
    expect((error as Error).message).not.toContain(PASSWORD);
  });

  it('bytes inválidos → PKCS12_MALFORMED', () => {
    expect(() => openPkcs12(Buffer.from('não é um pfx'), PASSWORD)).toThrow(Pkcs12Error);
  });

  describe.runIf(hasOpenssl())('PFX gerados pelo OpenSSL', () => {
    it('abre PFX legado (RC2/3DES, -legacy), comum em certificados A1 antigos', () => {
      const pfx = opensslPfx(pki.client.keyPem, pki.client.certPem, PASSWORD, true);
      const opened = openPkcs12(pfx, PASSWORD);
      expect(opened.certificate.checkPrivateKey(opened.privateKey)).toBe(true);
    });

    it('abre PFX moderno (PBES2/AES-256)', () => {
      const pfx = opensslPfx(pki.client.keyPem, pki.client.certPem, PASSWORD, false);
      expect(openPkcs12(pfx, PASSWORD).certificate.checkPrivateKey(openPkcs12(pfx, PASSWORD).privateKey)).toBe(true);
    });

    it('ACHADO: o TLS nativo do Node (OpenSSL 3) recusa o PFX legado → usar key+cert, não pfx', () => {
      const legacy = opensslPfx(pki.client.keyPem, pki.client.certPem, PASSWORD, true);
      expect(() => createSecureContext({ pfx: legacy, passphrase: PASSWORD })).toThrow();
      const opened = openPkcs12(legacy, PASSWORD);
      expect(() => createSecureContext({ key: opened.privateKey.export({ format: 'pem', type: 'pkcs8' }), cert: opened.certificatePem })).not.toThrow();
    });
  });
});

describe('Spike 01 — XMLDSig', () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    describe(name, () => {
      it('assina, verifica e detecta adulteração', () => {
        const opened = openPkcs12(pki.pfx(pki.client, PASSWORD, 'aes256'), PASSWORD);
        const signed = signEnveloped({ xml: SAMPLE, elementLocalName: 'infDPS', privateKey: opened.privateKey, certificatePem: opened.certificatePem, profile });

        expect(signed).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
        expect(signed).toContain('URI="#DPS221100621122233300018100001000000000000001"');
        expect(signed).toContain('<X509Certificate>');
        // Assinatura logo após infDPS, dentro de DPS.
        expect(signed.indexOf('</infDPS><Signature')).toBeGreaterThan(0);

        expect(verifyEnveloped(signed, opened.certificatePem)).toBe(true);
        const tampered = signed.replace('Servico de teste', 'Servico adulterado');
        expect(verifyEnveloped(tampered, opened.certificatePem)).toBe(false);
      });

      it.runIf(hasDocker())('assinatura é aceita por implementação independente (xmlsec1) e adulteração é rejeitada', () => {
        const opened = openPkcs12(pki.pfx(pki.client, PASSWORD, 'aes256'), PASSWORD);
        const signed = signEnveloped({ xml: SAMPLE, elementLocalName: 'infDPS', privateKey: opened.privateKey, certificatePem: opened.certificatePem, profile });

        const good = xmlsec1Verify(signed, pki.ca.caCertPem, { element: 'infDPS', namespace: NS });
        expect(good.output).toMatch(/OK/);
        expect(good.ok).toBe(true);

        const bad = xmlsec1Verify(signed.replace('<tpAmb>2', '<tpAmb>1'), pki.ca.caCertPem, { element: 'infDPS', namespace: NS });
        expect(bad.ok).toBe(false);
      }, 120_000);
    });
  }
});
