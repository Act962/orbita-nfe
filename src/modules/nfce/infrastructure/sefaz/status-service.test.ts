import { createPrivateKey } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../../../../../test/support/tls-test-pki.js';
import { createMtlsAgent } from '../../../../shared/infrastructure/transport/mtls-transport.js';
import { FiscalSchemaCatalog } from '../../../../shared/infrastructure/xml/fiscal-schema-catalog.js';
import { buildSoapEnvelope, readWsdlContract } from './sefaz-soap.js';
import { buildConsStatServ, queryServiceStatus, readStatusResponse, STATUS_SCHEMA_PACKAGE } from './status-service.js';

/**
 * Status do serviço da NFC-e (ADR-0063). O WSDL e as respostas abaixo são FICTÍCIOS, montados
 * só para exercitar a leitura: o namespace e a ação reais vêm sempre do WSDL do próprio SVRS.
 */
const TNS = 'http://www.portalfiscal.inf.br/nfe/wsdl/ServicoFicticio4';
const ACTION = `${TNS}/operacaoFicticia`;
const wsdl = (operations = [ACTION], dataElement = 'nfeDadosMsg') =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="${TNS}">` +
  `<wsdl:types><s:schema targetNamespace="${TNS}"><s:element name="${dataElement}"/><s:element name="resultadoFicticio"/></s:schema></wsdl:types>` +
  '<wsdl:binding name="b">' +
  operations.map((a) => `<wsdl:operation name="o"><soap12:operation soapAction="${a}" style="document"/></wsdl:operation>`).join('') +
  '</wsdl:binding></wsdl:definitions>';
const RET =
  '<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><verAplic>FICTICIO_1.0</verAplic>' +
  '<cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>22</cUF><dhRecbto>2026-11-25T10:00:00-03:00</dhRecbto><tMed>1</tMed></retConsStatServ>';
const soap = (body: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><resultadoFicticio xmlns="${TNS}">${body}</resultadoFicticio></soap:Body></soap:Envelope>`;
const FAULT =
  '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><soap:Fault><soap:Code><soap:Value>soap:Receiver</soap:Value></soap:Code>' +
  '<soap:Reason><soap:Text xml:lang="pt">Falha ficticia</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>';

let catalog: FiscalSchemaCatalog;
let pki: TestPki;
let server: Server;
let baseUrl: string;
const seen: Array<{ method: string; url: string; contentType: string | undefined; body: string }> = [];
let answer: { status: number; body: string } = { status: 200, body: soap(RET) };

beforeAll(async () => {
  catalog = FiscalSchemaCatalog.load(resolve(import.meta.dirname, '../../../../../resources/fiscal/schemas'));
  pki = createTestPki();
  server = createServer({ key: pki.server.keyPem, cert: pki.server.certPem, ca: pki.ca.caCertPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', contentType: req.headers['content-type'], body });
      if (req.method === 'GET' && req.url?.endsWith('?wsdl') === true) res.writeHead(200, { 'content-type': 'text/xml' }).end(wsdl());
      else res.writeHead(answer.status, { 'content-type': 'application/soap+xml' }).end(answer.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}/ws/Status4.asmx`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

const agent = () =>
  createMtlsAgent(
    { privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem, serverTrustPem: pki.ca.caCertPem },
    { connectTimeoutMs: 2000, headersTimeoutMs: 2000, bodyTimeoutMs: 2000, maxResponseBytes: 64 * 1024 },
  );

describe('consulta de status da NFC-e: mensagens (MOC 7.0, itens 4.4 e 5.5)', () => {
  it('consStatServ 4.00 válido no XSD oficial do PL_009q', async () => {
    const xml = buildConsStatServ({ tpAmb: '2', cUF: '22' });
    expect(xml).toBe('<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cUF>22</cUF><xServ>STATUS</xServ></consStatServ>');
    expect((await catalog.validate(STATUS_SCHEMA_PACKAGE, 'consStatServ_v4.00.xsd', xml)).valid).toBe(true);
    expect(() => buildConsStatServ({ tpAmb: '2', cUF: '2' })).toThrow();
  });

  it('envelope SOAP 1.2 sem Header, com o XML em nfeDadosMsg no namespace do WSDL', () => {
    const envelope = buildSoapEnvelope({ targetNamespace: TNS, soapAction: ACTION }, '<x/>');
    expect(envelope).toContain('<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>');
    expect(envelope).toContain(`<nfeDadosMsg xmlns="${TNS}"><x/></nfeDadosMsg>`);
    expect(envelope).not.toContain('Header');
  });

  it('WSDL: namespace e ação únicos; surpresas viram erro, nunca palpite', () => {
    expect(readWsdlContract(wsdl())).toEqual({ targetNamespace: TNS, soapAction: ACTION });
    expect(readWsdlContract(wsdl([ACTION, ACTION]))).toEqual({ targetNamespace: TNS, soapAction: ACTION });
    expect(() => readWsdlContract(wsdl([ACTION, `${ACTION}2`]))).toThrow('WSDL_SOAP12_OPERATION_NOT_UNIQUE');
    expect(() => readWsdlContract(wsdl([]))).toThrow('WSDL_SOAP12_OPERATION_NOT_UNIQUE');
    expect(() => readWsdlContract(wsdl([ACTION], 'outroElemento'))).toThrow('WSDL_WITHOUT_NFEDADOSMSG');
    expect(() => readWsdlContract('<html/>')).toThrow('WSDL_NOT_DEFINITIONS');
    expect(() => readWsdlContract('<!DOCTYPE x><x/>')).toThrow();
  });

  it('resposta: retConsStatServ validado no XSD; Fault e resposta fora do XSD são reconhecidos', async () => {
    expect(await readStatusResponse(soap(RET), catalog)).toMatchObject({
      kind: 'STATUS',
      status: { tpAmb: '2', verAplic: 'FICTICIO_1.0', cStat: '107', xMotivo: 'Servico em Operacao', cUF: '22', dhRecbto: '2026-11-25T10:00:00-03:00', tMed: '1' },
    });
    expect(await readStatusResponse(FAULT, catalog)).toMatchObject({ kind: 'SOAP_FAULT', code: 'soap:Receiver', reason: 'Falha ficticia' });
    expect(await readStatusResponse(soap(RET.replace('<cStat>107</cStat>', '<cStat>7</cStat>')), catalog)).toMatchObject({ kind: 'INVALID', step: 'response' });
    expect(await readStatusResponse(soap('<outro/>'), catalog)).toMatchObject({ kind: 'INVALID', reason: 'SEM_retConsStatServ' });
    expect(await readStatusResponse('não é xml', catalog)).toMatchObject({ kind: 'INVALID', step: 'response' });
  });
});

describe('consulta de status da NFC-e: fluxo com mTLS contra um servidor local', () => {
  it('lê o WSDL, envia UMA vez com Content-Type SOAP 1.2 e a ação do WSDL, e devolve o status', async () => {
    seen.length = 0;
    answer = { status: 200, body: soap(RET) };
    const result = await queryServiceStatus({ agent: agent(), url: baseUrl, query: { tpAmb: '2', cUF: '22' }, catalog });
    expect(result).toMatchObject({ kind: 'STATUS', status: { cStat: '107' } });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /ws/Status4.asmx?wsdl', 'POST /ws/Status4.asmx']);
    expect(seen[1]?.contentType).toBe(`application/soap+xml; charset=utf-8; action="${ACTION}"`);
    expect(seen[1]?.body).toContain('<cUF>22</cUF><xServ>STATUS</xServ>');
  });

  it('Fault com HTTP 500 é lido; HTTP de erro sem SOAP vira HTTP_ERROR', async () => {
    answer = { status: 500, body: FAULT };
    expect(await queryServiceStatus({ agent: agent(), url: baseUrl, query: { tpAmb: '2', cUF: '22' }, catalog })).toMatchObject({ kind: 'SOAP_FAULT' });
    answer = { status: 403, body: '<html>proibido</html>' };
    expect(await queryServiceStatus({ agent: agent(), url: baseUrl, query: { tpAmb: '2', cUF: '22' }, catalog })).toMatchObject({ kind: 'HTTP_ERROR', step: 'request', httpStatus: 403 });
  });

  it('falha de conexão no WSDL não envia nada e informa a fase', async () => {
    const result = await queryServiceStatus({ agent: agent(), url: 'https://localhost:1/ws/Status4.asmx', query: { tpAmb: '2', cUF: '22' }, catalog });
    expect(result).toMatchObject({ kind: 'TRANSPORT', step: 'wsdl', outcome: { kind: 'NOT_SENT', phase: 'connect' } });
  });
});
