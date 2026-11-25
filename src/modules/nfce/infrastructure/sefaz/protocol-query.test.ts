import { createPrivateKey } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../../../../../test/support/tls-test-pki.js';
import { createMtlsAgent } from '../../../../shared/infrastructure/transport/mtls-transport.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { buildConsSitNFe, PROTOCOL_SCHEMA_PACKAGE, queryProtocol, readProtocolResponse } from './protocol-query.js';

/**
 * Consulta da NFC-e pela chave (ADR-0064). Chave, WSDL e respostas FICTÍCIOS: só exercitam a
 * leitura do leiaute (MOC 7.0, item 5.4). A chave tem o formato do TChNFe, não é de nota real.
 */
const KEY = '22261111222333000181650010000000011000000019';
const TNS = 'http://www.portalfiscal.inf.br/nfe/wsdl/ConsultaFicticia4';
const ACTION = `${TNS}/operacaoFicticia`;
const WSDL =
  `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="${TNS}">` +
  `<wsdl:types><s:schema targetNamespace="${TNS}"><s:element name="nfeDadosMsg"/></s:schema></wsdl:types>` +
  `<wsdl:binding name="b"><wsdl:operation name="o"><soap12:operation soapAction="${ACTION}"/></wsdl:operation></wsdl:binding></wsdl:definitions>`;
const NS = 'http://www.portalfiscal.inf.br/nfe';
const PROT = (cStat: string) =>
  `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>FICTICIO</verAplic><chNFe>${KEY}</chNFe><dhRecbto>2026-11-25T10:00:00-03:00</dhRecbto>` +
  `<nProt>122260000000001</nProt><cStat>${cStat}</cStat><xMotivo>Ficticio</xMotivo></infProt></protNFe>`;
const RET = (cStat: string, extra = '') =>
  `<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>FICTICIO</verAplic><cStat>${cStat}</cStat><xMotivo>Ficticio</xMotivo>` +
  `<cUF>22</cUF><dhRecbto>2026-11-25T10:00:00-03:00</dhRecbto><chNFe>${KEY}</chNFe>${extra}</retConsSitNFe>`;
const soap = (body: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><r xmlns="${TNS}">${body}</r></soap:Body></soap:Envelope>`;

let catalog: FiscalSchemaCatalog;
let pki: TestPki;
let server: Server;
let baseUrl: string;
const posts: string[] = [];

beforeAll(async () => {
  catalog = FiscalSchemaCatalog.load(resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas'));
  pki = createTestPki();
  server = createServer({ key: pki.server.keyPem, cert: pki.server.certPem, ca: pki.ca.caCertPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.method === 'GET') return void res.writeHead(200).end(WSDL);
      posts.push(body);
      res.writeHead(200).end(soap(RET('100', PROT('100'))));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}/ws/Consulta4.asmx`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

describe('consulta da NFC-e pela chave (MOC 7.0, item 5.4)', () => {
  it('consSitNFe 4.00 válido no XSD do PL_010d, inclusive com CNPJ alfanumérico na chave', async () => {
    const xml = buildConsSitNFe({ tpAmb: '2', accessKey: KEY });
    expect(xml).toBe(`<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>${KEY}</chNFe></consSitNFe>`);
    expect((await catalog.validate(PROTOCOL_SCHEMA_PACKAGE, 'consSitNFe_v4.00.xsd', xml)).valid).toBe(true);
    const alnum = buildConsSitNFe({ tpAmb: '2', accessKey: `221111AB12CD34EF5601${KEY.slice(20)}`.slice(0, 44) });
    expect((await catalog.validate(PROTOCOL_SCHEMA_PACKAGE, 'consSitNFe_v4.00.xsd', alnum)).valid).toBe(true);
    expect(() => buildConsSitNFe({ tpAmb: '2', accessKey: KEY.slice(1) })).toThrow();
  });

  it('cStat 100 e 150 com protNFe: autorizada, com o protocolo inteiro guardado', async () => {
    for (const cStat of ['100', '150'] as const) {
      const result = await readProtocolResponse(soap(RET(cStat, PROT(cStat))), catalog);
      expect(result).toMatchObject({ kind: 'PROTOCOL', header: { cStat, chNFe: KEY, cUF: '22' }, situation: { kind: 'AUTHORIZED', cStat, nProt: '122260000000001', authorizedAt: '2026-11-25T10:00:00-03:00' } });
      expect(result.kind === 'PROTOCOL' && result.situation.kind === 'AUTHORIZED' && result.situation.protocolXml).toContain('<nProt>122260000000001</nProt>');
    }
  });

  it('100 sem protNFe não é prova de autorização: REFUSED', async () => {
    expect(await readProtocolResponse(soap(RET('100')), catalog)).toMatchObject({ situation: { kind: 'REFUSED', cStat: '100' } });
  });

  it('217 = não consta na base (J03); 101/151 = cancelada; 110 = denegada; outro cStat = recusada', async () => {
    expect(await readProtocolResponse(soap(RET('217')), catalog)).toMatchObject({ situation: { kind: 'NOT_FOUND', cStat: '217' } });
    expect(await readProtocolResponse(soap(RET('101')), catalog)).toMatchObject({ situation: { kind: 'CANCELLED', cStat: '101' } });
    expect(await readProtocolResponse(soap(RET('110', PROT('110'))), catalog)).toMatchObject({ situation: { kind: 'DENIED', cStat: '110' } });
    expect(await readProtocolResponse(soap(RET('226')), catalog)).toMatchObject({ situation: { kind: 'REFUSED', cStat: '226' } });
  });

  it('retorno fora do XSD não vira situação', async () => {
    expect(await readProtocolResponse(soap(RET('217').replace('<cUF>22</cUF>', '')), catalog)).toMatchObject({ kind: 'INVALID', step: 'response' });
  });

  it('fluxo com mTLS: WSDL, um POST com a chave, protocolo lido', async () => {
    const agent = createMtlsAgent(
      { privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem, serverTrustPem: pki.ca.caCertPem },
      { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyTimeoutMs: 2000, maxResponseBytes: 64 * 1024 },
    );
    const result = await queryProtocol({ agent, url: baseUrl, query: { tpAmb: '2', accessKey: KEY }, catalog });
    expect(result).toMatchObject({ kind: 'PROTOCOL', situation: { kind: 'AUTHORIZED' } });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`<nfeDadosMsg xmlns="${TNS}"><consSitNFe`);
  });
});
