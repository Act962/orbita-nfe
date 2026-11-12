import { createPrivateKey } from 'node:crypto';
import { resolve } from 'node:path';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestIcpPki } from '../../../../../test/support/icp-test-pki.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { SIGNATURE_PROFILES, verifyEnveloped } from '../../../../shared/infrastructure/xml/xml-signer.js';
import type { ServiceInvoice, ServiceInvoiceCancellation } from '../../application/ports.js';
import { canTransitionCancellation, CANCELLATION_STATES, pedRegEventoId } from '../../domain/cancellation.js';
import { buildCancellationXml, XmlCancellationPreparer } from './cancellation-xml.js';

const ROOT = resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas');
const PROD = 'nfse-nacional/1.01-20260209';
const PRODREST = 'nfse-nacional/1.01-20261020-prodrest';
/** Fictícia, válida nos dois pacotes (9ª posição 1 ou 2, como exige o TSIdPedRegEvt da produção restrita). */
const KEY = `000000022${'1'.repeat(41)}`;
const CNPJ = '11222333000181';

let catalog: FiscalSchemaCatalog;
beforeAll(() => {
  catalog = FiscalSchemaCatalog.load(ROOT);
});

const build = (overrides: Partial<Parameters<typeof buildCancellationXml>[0]> = {}) =>
  buildCancellationXml({
    tpAmb: '2',
    verAplic: 'orbita-nfe-teste',
    dhEvento: '2026-11-12T10:00:00-03:00',
    authorCnpj: CNPJ,
    accessKey: KEY,
    reasonCode: '1',
    reasonText: 'Erro na emissão: valor do serviço digitado errado',
    ...overrides,
  });

describe('pedido de cancelamento (TCPedRegEvt / TE101101) contra os XSD oficiais', () => {
  it.each([PROD, PRODREST])('%s: válido, com Id "PRE" + chave + 101101', async (pkg) => {
    const xml = build();
    expect(xml).toContain(`<infPedReg Id="PRE${KEY}101101">`);
    expect(xml).toContain('<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo>');
    expect((await catalog.validate(pkg, 'pedRegEvento_v1.01.xsd', xml)).errors).toEqual([]);
  }, 30_000);

  it('motivo fora do XSD (cMotivo 3, xMotivo curto) é recusado pelo XSD', async () => {
    expect((await catalog.validate(PROD, 'pedRegEvento_v1.01.xsd', build({ reasonCode: '3' }))).valid).toBe(false);
    expect((await catalog.validate(PROD, 'pedRegEvento_v1.01.xsd', build({ reasonText: 'curto' }))).valid).toBe(false);
  }, 30_000);

  it('texto do cliente é escapado (não vira marcação)', async () => {
    const xml = build({ reasonText: 'Motivo com </xMotivo><e101101> & outras <tags>' });
    expect(xml).toContain('Motivo com &lt;/xMotivo&gt;&lt;e101101&gt; &amp; outras &lt;tags&gt;');
    expect((await catalog.validate(PROD, 'pedRegEvento_v1.01.xsd', xml)).valid).toBe(true);
  }, 30_000);

  it('divergência entre os pacotes: a mesma chave de 50 dígitos com 3 na 9ª posição vale na produção e não na produção restrita', async () => {
    const xml = build({ accessKey: `000000023${'1'.repeat(41)}` });
    expect((await catalog.validate(PROD, 'pedRegEvento_v1.01.xsd', xml)).valid).toBe(true);
    expect((await catalog.validate(PRODREST, 'pedRegEvento_v1.01.xsd', xml)).valid).toBe(false);
  }, 30_000);

  it('chave fora da forma geral (50 posições) não monta', () => {
    expect(pedRegEventoId('SIM123')).toEqual({ ok: false, error: 'ACCESS_KEY_INVALID' });
    expect(() => build({ accessKey: '123' })).toThrow('ACCESS_KEY_INVALID');
  });
});

describe('XmlCancellationPreparer', () => {
  it.each(['HOMOLOGATION', 'PRODUCTION'] as const)('%s: assina infPedReg, valida no XSD do ambiente; a assinatura confere', async (environment) => {
    const leaf = createTestIcpPki().leaf({ cnpj: CNPJ });
    const credential = { privateKey: createPrivateKey(forge.pki.privateKeyToPem(leaf.key)), certificatePem: forge.pki.certificateToPem(leaf.cert) };
    const invoice = { environment, dpsId: `DPS22110012${CNPJ}00001${'1'.padStart(15, '0')}`, nfseAccessKey: KEY } as unknown as ServiceInvoice;
    const cancellation = { reasonCode: '2', reasonText: 'Serviço não foi prestado ao tomador' } as unknown as ServiceInvoiceCancellation;
    const result = await new XmlCancellationPreparer(catalog, 'orbita-nfe-teste', () => new Date('2026-11-12T13:00:00Z')).prepare(cancellation, invoice, credential);
    if (!result.ok) throw new Error(result.code);
    expect(result.layoutPackage).toBe(environment === 'PRODUCTION' ? PROD : PRODREST);
    expect(result.signedXml).toContain(`<tpAmb>${environment === 'PRODUCTION' ? '1' : '2'}</tpAmb>`);
    expect(result.signedXml).toContain(`<dhEvento>2026-11-12T10:00:00-03:00</dhEvento><CNPJAutor>${CNPJ}</CNPJAutor>`);
    expect(verifyEnveloped(result.signedXml, credential.certificatePem, SIGNATURE_PROFILES.nfseNacionalDps)).toEqual({ valid: true });

    const noKey = { ...invoice, nfseAccessKey: null } as unknown as ServiceInvoice;
    expect(await new XmlCancellationPreparer(catalog, 'teste').prepare(cancellation, noKey, credential)).toEqual({ ok: false, code: 'ACCESS_KEY_INVALID' });
  }, 30_000);
});

describe('máquina de estados do cancelamento', () => {
  it('UNKNOWN só sai para REGISTERED ou PENDING; finais sem saída', () => {
    expect(canTransitionCancellation('UNKNOWN', 'FAILED')).toBe(false);
    expect(canTransitionCancellation('UNKNOWN', 'REJECTED')).toBe(false);
    expect(canTransitionCancellation('UNKNOWN', 'REGISTERED')).toBe(true);
    expect(canTransitionCancellation('PROCESSING', 'UNKNOWN')).toBe(true);
    for (const final of ['REGISTERED', 'REJECTED', 'FAILED'] as const) {
      expect(CANCELLATION_STATES.filter((to) => canTransitionCancellation(final, to))).toEqual([]);
    }
  });
});
