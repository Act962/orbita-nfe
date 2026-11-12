import { createPrivateKey } from 'node:crypto';
import { resolve } from 'node:path';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleDpsData } from '../../../../../test/support/dps-fixtures.js';
import { createTestIcpPki } from '../../../../../test/support/icp-test-pki.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, signEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { IssuerCredential, ServiceInvoice } from '../../application/ports.js';
import { XmlDpsPreparer } from './xml-dps-preparer.js';
import { XmlNfseVerifier } from './xml-nfse-verifier.js';

const ROOT = resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas');
const PROD = 'nfse-nacional/1.01-20260209';
const PRODREST = 'nfse-nacional/1.01-20261020-prodrest';
const CNPJ = '11222333000181';
const DPS_ID = `DPS22110012${CNPJ}00001${'42'.padStart(15, '0')}`;
const OTHER_DPS_ID = `DPS22110012${CNPJ}00001${'43'.padStart(15, '0')}`;
const KEY_DIGITS = '2211001211222333000181000000000000001261100000000017'.slice(0, 50);

let catalog: FiscalSchemaCatalog;
let ours: IssuerCredential;
let stranger: IssuerCredential;

const credential = (pki: ReturnType<typeof createTestIcpPki>): IssuerCredential => {
  const leaf = pki.leaf({ cnpj: CNPJ });
  return { privateKey: createPrivateKey(forge.pki.privateKeyToPem(leaf.key)), certificatePem: forge.pki.certificateToPem(leaf.cert) };
};

beforeAll(() => {
  catalog = FiscalSchemaCatalog.load(ROOT);
  ours = credential(createTestIcpPki());
  stranger = credential(createTestIcpPki());
});

async function signedDps(environment: 'PRODUCTION' | 'HOMOLOGATION', key = ours, dpsId = DPS_ID): Promise<string> {
  const invoice = { id: 'x', environment, dpsId, series: '1', number: 42, payload: sampleDpsData() } as unknown as ServiceInvoice;
  const result = await new XmlDpsPreparer(catalog, 'orbita-nfe-teste', () => new Date('2026-11-12T13:00:00Z')).prepare(invoice, key);
  if (!result.ok) throw new Error(result.code);
  return result.signedXml;
}

const withoutDeclaration = (xml: string) => xml.replace(/^<\?xml[^>]*\?>/, '');

/**
 * NFS-e SINTÉTICA, montada só a partir do XSD (TCNFSe) para o teste: não é um documento emitido
 * pela SEFIN. A assinatura de `infNFSe` é estruturalmente válida, mas é feita antes de embutir a
 * DPS (o verificador não confere a assinatura da SEFIN; ADR-0034).
 */
function syntheticNfse(dps: string, options: { omit?: string; id?: string } = {}): string {
  const fields = [
    '<xLocEmi>Teresina</xLocEmi>',
    '<xLocPrestacao>Teresina</xLocPrestacao>',
    '<nNFSe>1</nNFSe>',
    '<xTribNac>Serviço fictício de teste</xTribNac>',
    '<verAplic>SEFIN-SIMULADA</verAplic>',
    '<ambGer>2</ambGer>',
    '<tpEmis>1</tpEmis>',
    '<cStat>100</cStat>',
    '<dhProc>2026-11-12T10:05:00-03:00</dhProc>',
    '<nDFSe>1</nDFSe>',
    `<emit><CNPJ>${CNPJ}</CNPJ><xNome>Emitente Fictício</xNome><enderNac><xLgr>Rua Fictícia</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>2211001</cMun><UF>PI</UF><CEP>64000000</CEP></enderNac></emit>`,
    '<valores><vLiq>1500.00</vLiq></valores>',
  ].filter((f) => options.omit === undefined || !f.startsWith(`<${options.omit}>`));
  const skeleton = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="${options.id ?? `NFS${KEY_DIGITS}`}">${fields.join('')}__DPS__</infNFSe></NFSe>`;
  const signed = signEnveloped({ xml: skeleton, elementLocalName: 'infNFSe', privateKey: stranger.privateKey, certificatePem: stranger.certificatePem, profile: SIGNATURE_PROFILES.nfseNacionalDps });
  return withoutDeclaration(signed).replace('__DPS__', withoutDeclaration(dps));
}

const expected = (signed: string | undefined, layoutPackage: string | null = PRODREST, environment: 'PRODUCTION' | 'HOMOLOGATION' = 'HOMOLOGATION') => ({
  dpsId: DPS_ID,
  environment,
  layoutPackage,
  signedDps: signed,
});

describe('XmlNfseVerifier (XML oficial trazido na resolução manual)', () => {
  it.each([
    ['HOMOLOGATION', PRODREST],
    ['PRODUCTION', PROD],
  ] as const)('%s: NFS-e válida no XSD, com a NOSSA DPS → chave, dhProc e assinatura da DPS conferida', async (environment, pkg) => {
    const dps = await signedDps(environment);
    const result = await new XmlNfseVerifier(catalog).verify(syntheticNfse(dps), expected(dps, pkg, environment));
    expect(result).toEqual({ ok: true, accessKey: KEY_DIGITS, processedAt: new Date('2026-11-12T13:05:00Z'), dpsSignature: 'MATCH' });
  }, 30_000);

  it('DPS embutida sem assinatura → aceita, registrada como ABSENT', async () => {
    const dps = await signedDps('HOMOLOGATION');
    const unsigned = dps.replace(/<Signature[\s\S]*<\/Signature>/, '');
    const result = await new XmlNfseVerifier(catalog).verify(syntheticNfse(unsigned), expected(dps));
    expect(result).toMatchObject({ ok: true, dpsSignature: 'ABSENT' });
  }, 30_000);

  it('DPS de outro número → NFSE_DPS_MISMATCH; mesma DPS assinada por OUTRA chave → NFSE_DPS_SIGNATURE_MISMATCH', async () => {
    const dps = await signedDps('HOMOLOGATION');
    const verifier = new XmlNfseVerifier(catalog);
    expect(await verifier.verify(syntheticNfse(await signedDps('HOMOLOGATION', ours, OTHER_DPS_ID)), expected(dps))).toEqual({ ok: false, code: 'NFSE_DPS_MISMATCH' });
    expect(await verifier.verify(syntheticNfse(await signedDps('HOMOLOGATION', stranger)), expected(dps))).toEqual({ ok: false, code: 'NFSE_DPS_SIGNATURE_MISMATCH' });
  }, 30_000);

  it('NFS-e de homologação apresentada para nota de produção → NFSE_ENVIRONMENT_MISMATCH', async () => {
    const dps = await signedDps('HOMOLOGATION');
    // Mesmo pacote para isolar a regra do ambiente da regra do XSD.
    const result = await new XmlNfseVerifier(catalog).verify(syntheticNfse(dps), expected(dps, PRODREST, 'PRODUCTION'));
    expect(result).toEqual({ ok: false, code: 'NFSE_ENVIRONMENT_MISMATCH' });
  }, 30_000);

  it('recusas de estrutura: fora do XSD, raiz errada, DOCTYPE, pacote desconhecido, sem DPS assinada local', async () => {
    const dps = await signedDps('HOMOLOGATION');
    const verifier = new XmlNfseVerifier(catalog);
    expect(await verifier.verify(syntheticNfse(dps, { omit: 'cStat' }), expected(dps))).toEqual({ ok: false, code: 'NFSE_SCHEMA_INVALID' });
    expect(await verifier.verify(syntheticNfse(dps, { id: 'NFS123' }), expected(dps))).toEqual({ ok: false, code: 'NFSE_SCHEMA_INVALID' });
    expect(await verifier.verify(dps, expected(dps))).toEqual({ ok: false, code: 'NFSE_XML_NOT_NFSE' });
    expect(await verifier.verify('<!DOCTYPE x [<!ENTITY a "b">]><NFSe/>', expected(dps))).toEqual({ ok: false, code: 'NFSE_XML_DOCTYPE_FORBIDDEN' });
    expect(await verifier.verify('<NFSe', expected(dps))).toEqual({ ok: false, code: 'NFSE_XML_MALFORMED' });
    expect(await verifier.verify(syntheticNfse(dps), expected(dps, 'teste/sem-xsd'))).toEqual({ ok: false, code: 'NFSE_LAYOUT_UNKNOWN' });
    expect(await verifier.verify(syntheticNfse(dps), expected(dps, null))).toEqual({ ok: false, code: 'NFSE_LAYOUT_UNKNOWN' });
    expect(await verifier.verify(syntheticNfse(dps), expected(undefined))).toEqual({ ok: false, code: 'SIGNED_DPS_MISSING' });
  }, 30_000);
});
