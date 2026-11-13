import { createPrivateKey } from 'node:crypto';
import { resolve } from 'node:path';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleDpsData } from '../../../../../test/support/dps-fixtures.js';
import { createTestIcpPki } from '../../../../../test/support/icp-test-pki.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, verifyEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { ServiceInvoice } from '../../application/ports.js';
import type { DpsData } from '../../domain/dps.js';
import { buildDpsXml, LayoutNotSupportedError } from './dps-xml.js';
import { formatDhEmi, XmlDpsPreparer, XmlDpsValidator } from './xml-dps-preparer.js';

const ROOT = resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas');
const PROD = 'nfse-nacional/1.01-20260209';
const PRODREST = 'nfse-nacional/1.01-20261020-prodrest';
const DPS_ID = 'DPS2211001211222333000181000010000000000000' + '42';

let catalog: FiscalSchemaCatalog;
beforeAll(() => {
  catalog = FiscalSchemaCatalog.load(ROOT);
});

const dps = (overrides: Record<string, unknown> = {}) => sampleDpsData(overrides) as unknown as DpsData;

const input = (layoutPackage: string, data: DpsData = dps()) => ({
  layoutPackage,
  dpsId: DPS_ID,
  tpAmb: '2' as const,
  dhEmi: '2026-11-12T10:00:00-03:00',
  verAplic: 'orbita-nfe-teste',
  series: '1',
  number: 42,
  issuerMunicipalityCode: '2211001',
  issuerCnpj: '11222333000181',
  dps: data,
});

const build = (layoutPackage: string, data: DpsData) =>
  buildDpsXml({
    layoutPackage,
    dpsId: DPS_ID,
    tpAmb: '2',
    dhEmi: '2026-11-12T10:00:00-03:00',
    verAplic: 'orbita-nfe-teste',
    series: '1',
    number: 42,
    issuerMunicipalityCode: '2211001',
    issuerCnpj: '11222333000181',
    dps: data,
  });

const FULL = dps({
  provider: { simplesNacionalOption: '3', simplesNacionalRegime: '1', specialTaxRegime: '0', municipalRegistration: '12345' },
  taker: { document: { type: 'CPF', value: '12345678909' }, name: 'Tomador Fictício & Cia', municipalRegistration: '999', email: 'tomador@exemplo.com' },
  service: { municipalityCode: '2211001', nationalTaxCode: '010101', municipalTaxCode: '001', nbsCode: '123456789', description: 'Serviço com acentuação, quebra\nde linha e símbolos < > &' },
  values: { serviceAmount: '1500.00', issqn: { taxation: '1', retention: '2', rate: '2.00' }, approximateTaxes: { kind: 'PERCENTAGES', federal: '13.45', state: '0', municipal: '2.00' } },
});

describe('buildDpsXml contra os XSD oficiais', () => {
  it.each([PROD, PRODREST])('%s: DPS mínima e DPS com todos os campos do contrato v1 são válidas', async (pkg) => {
    for (const data of [dps(), FULL]) {
      const result = await catalog.validate(pkg, 'DPS_v1.01.xsd', build(pkg, data));
      expect(result.errors).toEqual([]);
    }
  }, 30_000);

  it.each([
    ['AMOUNTS', { kind: 'AMOUNTS', federal: '10.00', state: '0.00', municipal: '3.00' }],
    ['SIMPLES_NACIONAL_RATE', { kind: 'SIMPLES_NACIONAL_RATE', rate: '6.00' }],
    ['NOT_INFORMED', { kind: 'NOT_INFORMED' }],
  ])('totais aproximados %s são válidos nos dois pacotes', async (_name, approximateTaxes) => {
    const data = dps({ values: { serviceAmount: '100.00', issqn: { taxation: '1', retention: '1' }, approximateTaxes } });
    for (const pkg of [PROD, PRODREST]) expect((await catalog.validate(pkg, 'DPS_v1.01.xsd', build(pkg, data))).errors).toEqual([]);
  }, 30_000);

  it.each([PROD, PRODREST])('%s: substituta com o grupo subst (depois de cLocEmi) é válida; código fora de TSCodJustSubst não', async (pkg) => {
    const key = `000000022${'1'.repeat(41)}`;
    const ok = buildDpsXml({ ...input(pkg), substitution: { accessKey: key, reasonCode: '99', reasonText: 'Correção da descrição do serviço' } });
    expect(ok).toContain(`<cLocEmi>2211001</cLocEmi><subst><chSubstda>${key}</chSubstda><cMotivo>99</cMotivo><xMotivo>Correção da descrição do serviço</xMotivo></subst><prest>`);
    expect((await catalog.validate(pkg, 'DPS_v1.01.xsd', ok)).errors).toEqual([]);
    const withoutText = buildDpsXml({ ...input(pkg), substitution: { accessKey: key, reasonCode: '01', reasonText: null } });
    expect(withoutText).toContain('<cMotivo>01</cMotivo></subst>');
    expect((await catalog.validate(pkg, 'DPS_v1.01.xsd', withoutText)).errors).toEqual([]);
    // O leiaute do Anexo I escreve "1 - ..." (1 posição); o XSD exige "01". Quem valida é o XSD.
    const oneDigit = buildDpsXml({ ...input(pkg), substitution: { accessKey: key, reasonCode: '1', reasonText: null } });
    expect((await catalog.validate(pkg, 'DPS_v1.01.xsd', oneDigit)).valid).toBe(false);
  }, 30_000);

  it('a ordem de cServ segue cada pacote: xDescServ antes de cNBS (produção) e no fim (produção restrita)', () => {
    expect(build(PROD, FULL)).toMatch(/<xDescServ>.*<\/xDescServ><cNBS>/s);
    expect(build(PRODREST, FULL)).toMatch(/<cNBS>123456789<\/cNBS><xDescServ>/);
    expect(build(PROD, FULL)).not.toContain('<finNFSe>');
    expect(build(PRODREST, FULL)).toContain('<tpEmit>1</tpEmit><finNFSe>0</finNFSe>');
  });

  it('texto do cliente nunca vira marcação (tentativa de injeção de XML)', async () => {
    const attack = dps({
      service: { municipalityCode: '2211001', nationalTaxCode: '010101', description: '</xDescServ><cTribMun>999</cTribMun><xDescServ>x' },
    });
    const xml = build(PRODREST, attack);
    expect(xml).toContain('&lt;/xDescServ&gt;&lt;cTribMun&gt;999');
    expect(xml.match(/<cTribMun>/g)).toBeNull();
    expect((await catalog.validate(PRODREST, 'DPS_v1.01.xsd', xml)).valid).toBe(true);
  }, 30_000);

  it('pacote sem perfil de leiaute não monta', () => {
    expect(() => build('nfse-nacional/9.99-inexistente', dps())).toThrow(LayoutNotSupportedError);
  });

  it('dhEmi em horário de Brasília (UTC−03:00)', () => {
    expect(formatDhEmi(new Date('2026-11-12T13:05:09.123Z'))).toBe('2026-11-12T10:05:09-03:00');
    expect(formatDhEmi(new Date('2026-11-12T01:00:00Z'))).toBe('2026-11-11T22:00:00-03:00');
  });
});

describe('XmlDpsPreparer e XmlDpsValidator', () => {
  const invoice = (environment: 'PRODUCTION' | 'HOMOLOGATION', data: DpsData): ServiceInvoice =>
    ({ id: 'x', environment, dpsId: DPS_ID, series: '1', number: 42, payload: data }) as unknown as ServiceInvoice;

  it.each(['HOMOLOGATION', 'PRODUCTION'] as const)('%s: assina e valida no XSD do ambiente; a assinatura confere', async (environment) => {
    const pki = createTestIcpPki();
    const leaf = pki.leaf({ cnpj: '11222333000181' });
    const credential = { privateKey: createPrivateKey(forge.pki.privateKeyToPem(leaf.key)), certificatePem: forge.pki.certificateToPem(leaf.cert) };
    const preparer = new XmlDpsPreparer(catalog, 'orbita-nfe-teste', () => new Date('2026-11-12T13:00:00Z'));
    const result = await preparer.prepare(invoice(environment, FULL), credential);
    if (!result.ok) throw new Error(result.code);
    expect(result.layoutPackage).toBe(environment === 'PRODUCTION' ? PROD : PRODREST);
    expect(result.signedXml).toContain(`<tpAmb>${environment === 'PRODUCTION' ? '1' : '2'}</tpAmb><dhEmi>2026-11-12T10:00:00-03:00</dhEmi>`);
    expect(verifyEnveloped(result.signedXml, credential.certificatePem, SIGNATURE_PROFILES.nfseNacionalDps)).toEqual({ valid: true });
  }, 30_000);

  it('DPS que passa no formato mas não no XSD (data inexistente) → DPS_SCHEMA_INVALID; o validador do aceite também acusa', async () => {
    const pki = createTestIcpPki();
    const leaf = pki.leaf({ cnpj: '11222333000181' });
    const credential = { privateKey: createPrivateKey(forge.pki.privateKeyToPem(leaf.key)), certificatePem: forge.pki.certificateToPem(leaf.cert) };
    const bad = dps({ competenceDate: '2026-02-30' });
    expect(await new XmlDpsPreparer(catalog, 'teste').prepare(invoice('HOMOLOGATION', bad), credential)).toEqual({ ok: false, code: 'DPS_SCHEMA_INVALID' });
    expect((await new XmlDpsValidator(catalog).validate('HOMOLOGATION', bad)).length).toBeGreaterThan(0);
    expect(await new XmlDpsValidator(catalog).validate('PRODUCTION', FULL)).toEqual([]);
  }, 30_000);
});
