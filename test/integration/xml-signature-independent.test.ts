import { createSecureContext } from 'node:tls';
import { resolve } from 'node:path';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { ForgePkcs12Reader } from '../../src/modules/certificates/public.js';
import { FiscalSchemaCatalog } from '../../src/shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../src/shared/infrastructure/xml/xml-signer.js';
import { MINIMAL_DPS_BY_PACKAGE, NFSE_NS } from '../support/dps-fixtures.js';
import { hasDocker, hasOpenssl, opensslPfx, xmlsec1Verify } from '../support/external-tools.js';
import { createTestIcpPki, type TestIcpPki } from '../support/icp-test-pki.js';

/**
 * Provas independentes do código promovido dos spikes 01 e 03 (ADR-0014):
 * - a assinatura da DPS é aceita pelo xmlsec1 (libxml2 + OpenSSL), outra implementação;
 * - o XML assinado continua válido contra o XSD oficial, com o import do XMLDSig;
 * - PFX legado (RC2/3DES, `openssl -legacy`) abre pelo node-forge, e o TLS do Node o recusa.
 */
const PASSWORD = 'CANARY-PASSWORD-7f3a91c2';
const ROOT = resolve(import.meta.dirname, '../../resources/fiscal/schemas');

let pki: TestIcpPki;
let signed: string;
let caChainPem: string[];
let leafKeyPem: string;
let leafCertPem: string;

beforeAll(() => {
  pki = createTestIcpPki();
  const leaf = pki.leaf({ cnpj: '11222333000181' });
  leafKeyPem = forge.pki.privateKeyToPem(leaf.key);
  leafCertPem = forge.pki.certificateToPem(leaf.cert);
  caChainPem = [pki.root.certPem, pki.intermediate.certPem];
  const asn1 = forge.pkcs12.toPkcs12Asn1(leaf.key, [leaf.cert, leaf.issuer.cert], PASSWORD, { algorithm: 'aes256' });
  const read = new ForgePkcs12Reader().read({ pfx: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), password: Buffer.from(PASSWORD) });
  if (!read.ok) throw new Error('PFX de teste ilegível');
  const build = MINIMAL_DPS_BY_PACKAGE['nfse-nacional/1.01-20261020-prodrest'];
  if (build === undefined) throw new Error('sem DPS mínima');
  signed = signEnveloped({
    xml: build(),
    elementLocalName: 'infDPS',
    privateKey: read.value.privateKey,
    certificatePem: read.value.certificatePem,
    profile: SIGNATURE_PROFILES.nfseNacionalDps,
  });
});

describe('assinatura da DPS verificada por implementação independente', () => {
  it('o XML assinado é válido contra o XSD oficial de produção restrita', async () => {
    const catalog = FiscalSchemaCatalog.load(ROOT);
    const result = await catalog.validate('nfse-nacional/1.01-20261020-prodrest', 'DPS_v1.01.xsd', signed);
    expect(result.errors).toEqual([]);
  }, 20_000);

  it.runIf(hasDocker())('xmlsec1 aceita a assinatura e recusa o documento adulterado', () => {
    const good = xmlsec1Verify(signed, caChainPem, { element: 'infDPS', namespace: NFSE_NS });
    expect(good.output).toMatch(/OK/);
    expect(good.ok).toBe(true);
    const bad = xmlsec1Verify(signed.replace('<tpAmb>2', '<tpAmb>1'), caChainPem, { element: 'infDPS', namespace: NFSE_NS });
    expect(bad.ok).toBe(false);
  }, 180_000);
});

describe.runIf(hasOpenssl())('PFX gerado pelo OpenSSL', () => {
  it.each([
    ['legado (RC2/3DES, -legacy), comum em A1 antigos', true],
    ['moderno (PBES2/AES-256)', false],
  ])('%s abre pelo ForgePkcs12Reader', (_name, legacy) => {
    const pfx = opensslPfx(leafKeyPem, leafCertPem, PASSWORD, legacy);
    const read = new ForgePkcs12Reader().read({ pfx, password: Buffer.from(PASSWORD) });
    expect(read.ok).toBe(true);
  });

  it('o TLS nativo do Node recusa o PFX legado: por isso o agente usa key + cert (ADR-0014, regra 1)', () => {
    const legacy = opensslPfx(leafKeyPem, leafCertPem, PASSWORD, true);
    expect(() => createSecureContext({ pfx: legacy, passphrase: PASSWORD })).toThrow();
    const read = new ForgePkcs12Reader().read({ pfx: legacy, password: Buffer.from(PASSWORD) });
    if (!read.ok) throw new Error('PFX legado ilegível');
    expect(() => createSecureContext({ key: read.value.privateKey.export({ format: 'pem', type: 'pkcs8' }), cert: read.value.certificatePem })).not.toThrow();
  });
});
