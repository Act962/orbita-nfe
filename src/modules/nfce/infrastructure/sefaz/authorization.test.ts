import { createPrivateKey } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleTestNfce, type TestNfce } from '../../../../../test/support/nfce-fixtures.js';
import { createTestPki, type TestPki } from '../../../../../test/support/tls-test-pki.js';
import { createMtlsAgent } from '../../../../shared/infrastructure/transport/mtls-transport.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { authorize, AUTHORIZATION_SCHEMA_PACKAGE, buildEnviNFe, readAuthorizationResponse } from './authorization.js';

/**
 * Autorização síncrona da NFC-e (ADR-0070). WSDL, respostas e nota FICTÍCIOS, contra um servidor
 * mTLS local: exercitam a leitura do leiaute (MOC 7.0, item 5.1) e a regra de que só a resposta
 * que prova o resultado vira estado final.
 */
const TNS = 'http://www.portalfiscal.inf.br/nfe/wsdl/AutorizacaoFicticia4';
const ACTION = `${TNS}/operacaoFicticia`;
const WSDL =
  `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="${TNS}">` +
  `<wsdl:types><s:schema targetNamespace="${TNS}"><s:element name="nfeDadosMsg"/></s:schema></wsdl:types>` +
  `<wsdl:binding name="b"><wsdl:operation name="o"><soap12:operation soapAction="${ACTION}"/></wsdl:operation></wsdl:binding></wsdl:definitions>`;
const NS = 'http://www.portalfiscal.inf.br/nfe';
const soap = (body: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><r xmlns="${TNS}">${body}</r></soap:Body></soap:Envelope>`;

let catalog: FiscalSchemaCatalog;
let pki: TestPki;
let nfce: TestNfce;
let server: Server;
let baseUrl: string;
let nextResponse = '';
const posts: string[] = [];

function prot(cStat: string, opts: { key?: string; digVal?: string; nProt?: boolean } = {}): string {
  return (
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>FICTICIO</verAplic><chNFe>${opts.key ?? nfce.accessKey}</chNFe>` +
    `<dhRecbto>2026-11-26T10:00:01-03:00</dhRecbto>${opts.nProt === false ? '' : '<nProt>122260000000042</nProt>'}` +
    `<digVal>${opts.digVal ?? nfce.digestValue}</digVal><cStat>${cStat}</cStat><xMotivo>Ficticio ${cStat}</xMotivo></infProt></protNFe>`
  );
}

function ret(cStat: string, extra = ''): string {
  return (
    `<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>FICTICIO</verAplic><cStat>${cStat}</cStat><xMotivo>Lote ${cStat}</xMotivo>` +
    `<cUF>22</cUF><dhRecbto>2026-11-26T10:00:01-03:00</dhRecbto>${extra}</retEnviNFe>`
  );
}

const read = async (body: string) => readAuthorizationResponse(soap(body), catalog, { accessKey: nfce.accessKey, digestValue: nfce.digestValue });

beforeAll(async () => {
  catalog = FiscalSchemaCatalog.load(resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas'));
  pki = createTestPki();
  nfce = assembleTestNfce(pki);
  server = createServer({ key: pki.server.keyPem, cert: pki.server.certPem, ca: pki.ca.caCertPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.method === 'GET') return void res.writeHead(200).end(WSDL);
      posts.push(body);
      res.writeHead(200).end(nextResponse);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}/ws/NFeAutorizacao4.asmx`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

describe('enviNFe da NFC-e (MOC 7.0, item 5.1; NT 2023.002)', () => {
  it('lote síncrono com uma NFe, válido no XSD do PL_009q composto com o leiaute do PL_010h', async () => {
    const xml = buildEnviNFe({ batchId: '1', signedNfeXml: nfce.xml });
    expect(xml.startsWith(`<enviNFe xmlns="${NS}" versao="4.00"><idLote>1</idLote><indSinc>1</indSinc><NFe`)).toBe(true);
    const valid = await catalog.validate(AUTHORIZATION_SCHEMA_PACKAGE, 'enviNFe_v4.00.xsd', xml);
    expect(valid.errors).toEqual([]);
  });

  it('recusa lote vazio, com duas notas ou idLote fora do TIdLote', () => {
    expect(() => buildEnviNFe({ batchId: '1', signedNfeXml: nfce.xml + nfce.xml })).toThrow();
    expect(() => buildEnviNFe({ batchId: '1', signedNfeXml: '<outro/>' })).toThrow();
    expect(() => buildEnviNFe({ batchId: '1234567890123456', signedNfeXml: nfce.xml })).toThrow();
  });
});

describe('retorno da autorização: só o que prova vira estado final', () => {
  it('104 + protNFe 100/150 da nossa chave e do nosso digest → AUTHORIZED, com o protocolo inteiro', async () => {
    for (const cStat of ['100', '150'] as const) {
      const result = await read(ret('104', prot(cStat)));
      expect(result).toMatchObject({ kind: 'OUTCOME', outcome: { kind: 'AUTHORIZED', cStat, nProt: '122260000000042', authorizedAt: '2026-11-26T10:00:01-03:00' } });
      expect(result.kind === 'OUTCOME' && result.outcome.kind === 'AUTHORIZED' && result.outcome.protocolXml).toContain('<nProt>122260000000042</nProt>');
    }
  });

  it('denegação (110, 301, 302, 303) grava a nota: DENIED, nunca REJECTED', async () => {
    for (const cStat of ['110', '301', '302', '303']) {
      expect(await read(ret('104', prot(cStat)))).toMatchObject({ outcome: { kind: 'DENIED', cStat } });
    }
  });

  it('rejeição da nota (ex.: 725) e do lote (ex.: 225, sem protocolo)', async () => {
    expect(await read(ret('104', prot('725', { nProt: false })))).toMatchObject({ outcome: { kind: 'REJECTED', cStat: '725', level: 'INVOICE' } });
    expect(await read(ret('225'))).toMatchObject({ outcome: { kind: 'REJECTED', cStat: '225', level: 'BATCH' } });
  });

  it('duplicidade (204, 205, 539) não é rejeição: ALREADY_EXISTS, a resolver pela consulta', async () => {
    for (const cStat of ['204', '205', '539']) {
      expect(await read(ret('104', prot(cStat, { nProt: false })))).toMatchObject({ outcome: { kind: 'ALREADY_EXISTS', cStat } });
    }
  });

  it('resposta que não prova nada → UNCERTAIN (a nota pode estar autorizada)', async () => {
    expect(await read(ret('103', '<infRec><nRec>221000000000001</nRec><tMed>1</tMed></infRec>'))).toMatchObject({ outcome: { kind: 'UNCERTAIN', reason: 'LOTE_ASSINCRONO_103' } });
    expect(await read(ret('104', prot('100', { key: nfce.accessKey.replace(/.$/, (d) => String((Number(d) + 1) % 10)) })))).toMatchObject({
      outcome: { kind: 'UNCERTAIN', reason: 'PROTOCOLO_DE_OUTRA_CHAVE' },
    });
    expect(await read(ret('104', prot('100', { digVal: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' })))).toMatchObject({ outcome: { kind: 'UNCERTAIN', reason: 'DIGEST_DIFERENTE' } });
    expect(await read(ret('104', prot('100', { nProt: false })))).toMatchObject({ outcome: { kind: 'UNCERTAIN', reason: 'AUTORIZADA_SEM_NPROT' } });
  });

  it('retorno fora do XSD não vira resultado', async () => {
    expect(await read(ret('104', prot('100')).replace('<cUF>22</cUF>', ''))).toMatchObject({ kind: 'INVALID', step: 'response' });
  });

  it('fluxo com mTLS: WSDL, UM POST com o lote, autorização lida', async () => {
    nextResponse = soap(ret('104', prot('100')));
    const agent = createMtlsAgent(
      { privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem, serverTrustPem: pki.ca.caCertPem },
      { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyTimeoutMs: 2000, maxResponseBytes: 256 * 1024 },
    );
    try {
      const result = await authorize({ agent, url: baseUrl, batchId: '7', signedNfeXml: nfce.xml, expected: { accessKey: nfce.accessKey, digestValue: nfce.digestValue }, catalog });
      expect(result).toMatchObject({ kind: 'OUTCOME', outcome: { kind: 'AUTHORIZED', cStat: '100' } });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain(`<nfeDadosMsg xmlns="${TNS}"><enviNFe`);
      expect(posts[0]).toContain('<indSinc>1</indSinc>');
    } finally {
      await agent.close();
    }
  });
});
