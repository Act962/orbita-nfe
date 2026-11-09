import { beforeAll, describe, expect, it } from 'vitest';
import { openPkcs12 } from '../01-pkcs12-xmldsig/pkcs12.js';
import { ALGORITHMS, signEnveloped } from '../01-pkcs12-xmldsig/xml-signer.js';
import { createTestPki, type TestPki } from '../support/test-pki.js';
import { DPS_SCHEMA, TIPOS_SIMPLES, XMLDSIG_STUB, dps } from './fixtures.js';
import { parseUntrustedXml, UntrustedXmlError, validateAgainstSchema, type SchemaBundle } from './schema-validator.js';

const BUNDLE: SchemaBundle = {
  main: 'DPS_teste.xsd',
  files: [
    { fileName: 'DPS_teste.xsd', contents: DPS_SCHEMA },
    { fileName: 'tiposSimples_teste.xsd', contents: TIPOS_SIMPLES },
    { fileName: 'xmldsig-core-schema.xsd', contents: XMLDSIG_STUB },
  ],
};

let pki: TestPki;
beforeAll(() => {
  pki = createTestPki();
});

describe('Spike 03 — validação XSD (libxml2/wasm) com include e import', () => {
  it('aceita documento válido', async () => {
    const result = await validateAgainstSchema(dps(), BUNDLE);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each([
    ['enumeração inválida', { tpAmb: '3' }],
    ['padrão decimal inválido', { vServ: '1500,00' }],
    ['campo obrigatório ausente', { vServ: '' }],
    ['ordem de elementos errada', { swapOrder: true }],
    ['elemento não previsto', { extra: '<campoInventado>1</campoInventado>' }],
    ['texto vazio abaixo do mínimo', { desc: '' }],
  ])('rejeita: %s, com mensagem e linha', async (_name, fields) => {
    const result = await validateAgainstSchema(dps(fields), BUNDLE);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toBeTruthy();
  });

  it('documento assinado (spike 01) valida com o import do namespace XMLDSig', async () => {
    const opened = openPkcs12(pki.pfx(pki.client, 'senha', 'aes256'), 'senha');
    const signed = signEnveloped({
      xml: dps().replace('<infDPS Id="DPS0001">', '<infDPS Id="DPS0001">'),
      elementLocalName: 'infDPS',
      privateKey: opened.privateKey,
      certificatePem: opened.certificatePem,
      profile: {
        signatureAlgorithm: ALGORITHMS.rsaSha256,
        digestAlgorithm: ALGORITHMS.sha256,
        canonicalizationAlgorithm: ALGORITHMS.c14n10,
        transforms: [ALGORITHMS.envelopedSignature, ALGORITHMS.c14n10],
      },
    });
    // A assinatura fica após infDPS, dentro de DPS — posição prevista no schema.
    const result = await validateAgainstSchema(signed, BUNDLE);
    expect(result.errors).toEqual([]);
  });

  it('não resolve entidade externa nem acessa disco/rede (XXE) durante a validação', async () => {
    const xxe = dps({ desc: '&xxe;' }).replace('<DPS ', '<!DOCTYPE DPS [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><DPS ');
    const result = await validateAgainstSchema(xxe, BUNDLE);
    expect(JSON.stringify(result)).not.toContain('root:');
  });

  it('desempenho: 50 validações sequenciais', async () => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) await validateAgainstSchema(dps(), BUNDLE);
    const perDoc = (performance.now() - start) / 50;
    console.info(`[spike03] validação XSD: ${perDoc.toFixed(1)} ms/documento`);
    expect(perDoc).toBeLessThan(500);
  });
});

describe('Spike 03 — parser de XML não confiável', () => {
  it('aceita resposta normal', () => {
    const doc = parseUntrustedXml('<retorno><cStat>100</cStat></retorno>');
    expect(doc.getElementsByTagName('cStat').item(0)?.textContent).toBe('100');
  });

  it.each([
    ['XXE externo', '<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>'],
    ['billion laughs', '<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>'],
    ['doctype minúsculo', '<!doctype r><r/>'],
  ])('recusa %s', (_name, xml) => {
    expect(() => parseUntrustedXml(xml)).toThrow(UntrustedXmlError);
  });

  it('recusa XML malformado e grande demais', () => {
    expect(() => parseUntrustedXml('<a><b></a>')).toThrow(UntrustedXmlError);
    expect(() => parseUntrustedXml(`<a>${'x'.repeat(2000)}</a>`, 1000)).toThrow(UntrustedXmlError);
  });
});
