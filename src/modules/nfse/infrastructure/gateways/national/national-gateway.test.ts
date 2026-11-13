import { createPrivateKey } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../../../../../../test/support/tls-test-pki.js';
import type { GatewayContext } from '../../../application/ports.js';
import { NationalNfseGateway, pack, SEFIN_NACIONAL } from './national-gateway.js';

/**
 * Cliente do padrão nacional contra uma SEFIN FALSA local (HTTPS com mTLS), que responde nos
 * formatos do Swagger da produção restrita (2026-11-13). Nenhuma requisição sai da máquina.
 */
const DPS_ID = 'DPS221100121122233300018100001000000000000042';
const KEY = `000000022${'1'.repeat(41)}`;
const DPS = `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${DPS_ID}"><tpAmb>2</tpAmb></infDPS></DPS>`;
const NFSE = `<NFSe><infNFSe Id="NFS${KEY}"/></NFSe>`;
const EVENT = `<evento><infEvento Id="EVT…"/></evento>`;

type Reply = { status: number; body?: unknown; hang?: true; raw?: string };
let pki: TestPki;
let server: Server;
let base: string;
let next: Record<string, Reply> = {};
let seen: { method: string; path: string; body: string; clientCert: boolean }[] = [];

const gz = (xml: string) => gzipSync(Buffer.from(xml)).toString('base64');
const meta = { tipoAmbiente: 2, versaoAplicativo: 'teste', dataHoraProcessamento: '2026-11-13T15:15:43-03:00' };

beforeAll(async () => {
  pki = createTestPki();
  server = createServer({ key: pki.server.keyPem, cert: pki.server.certPem, ca: pki.ca.caCertPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const path = (req.url ?? '').replace('/SefinNacional', '');
      seen.push({ method: req.method ?? '', path, body, clientCert: (req.socket as { authorized?: boolean }).authorized === true });
      const reply = next[`${req.method} ${path}`] ?? { status: 404, body: { ...meta, erro: { codigo: 'E9999', descricao: 'não programado' } } };
      if (reply.hang) return;
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://localhost:${(server.address() as AddressInfo).port}/SefinNacional`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  next = {};
  seen = [];
});

const context = (): GatewayContext => ({ environment: 'HOMOLOGATION', credential: { privateKey: createPrivateKey(pki.client.keyPem), certificatePem: pki.client.certPem } });
const LIMITS = { connectTimeoutMs: 2000, headersTimeoutMs: 800, bodyTimeoutMs: 800, maxResponseBytes: 1024 * 1024, maxXmlBytes: 1024 * 1024 };
const gateway = (url = base) => new NationalNfseGateway({ id: 'sefin-teste', baseUrls: { HOMOLOGATION: url }, serverTrustPem: pki.ca.caCertPem }, LIMITS);

describe('NationalNfseGateway.submit (POST /nfse)', () => {
  it('201: envia { dpsXmlGZipB64 } com mTLS e devolve chave e XML da NFS-e descompactados', async () => {
    next['POST /nfse'] = { status: 201, body: { ...meta, idDps: DPS_ID, chaveAcesso: KEY, nfseXmlGZipB64: gz(NFSE), alertas: [] } };
    expect(await gateway().submit(DPS, context())).toEqual({ kind: 'AUTHORIZED', accessKey: KEY, nfseXml: NFSE });
    const request = seen[0];
    expect(request).toMatchObject({ method: 'POST', path: '/nfse', clientCert: true });
    const sent = JSON.parse(request?.body ?? '{}') as { dpsXmlGZipB64: string };
    expect(Object.keys(sent)).toEqual(['dpsXmlGZipB64']);
    expect(gunzipSync(Buffer.from(sent.dpsXmlGZipB64, 'base64')).toString('utf8')).toBe(DPS);
  });

  it('400 com E0014 (DPS já recebida) → ALREADY_EXISTS; com outro Exxxx → REJECTED com todas as mensagens', async () => {
    next['POST /nfse'] = { status: 400, body: { ...meta, idDPS: DPS_ID, erros: [{ codigo: 'E0014', descricao: 'Conjunto já existe' }] } };
    expect(await gateway().submit(DPS, context())).toEqual({ kind: 'ALREADY_EXISTS' });
    next['POST /nfse'] = { status: 400, body: { ...meta, erros: [{ codigo: 'E0039', descricao: 'Município não parametrizado', complemento: 'detalhe' }, { codigo: 'E0712', descricao: 'Outra' }] } };
    expect(await gateway().submit(DPS, context())).toEqual({ kind: 'REJECTED', code: 'E0039', message: 'E0039: Município não parametrizado — detalhe; E0712: Outra' });
  });

  it('formato REAL observado na produção restrita (2026-11-13): erros[].Codigo/Descricao com inicial maiúscula → REJECTED', async () => {
    // Corpo copiado da resposta da SEFIN (SefinNacional_1.6.0) ao primeiro envio real.
    next['POST /nfse'] = {
      status: 400,
      raw: '{"tipoAmbiente":2,"versaoAplicativo":"SefinNacional_1.6.0","dataHoraProcessamento":"2026-11-13T16:18:10.3495445-03:00","idDPS":"' +
        DPS_ID +
        '","erros":[{"Codigo":"E0037","Descricao":"O código do município emissor informado na DPS é inexistente no cadastro de convênio municipal do sistema nacional."}]}',
    };
    expect(await gateway().submit(DPS, context())).toEqual({
      kind: 'REJECTED',
      code: 'E0037',
      message: 'E0037: O código do município emissor informado na DPS é inexistente no cadastro de convênio municipal do sistema nacional.',
    });
    // Consulta: 404 real com erro.codigo em minúsculas (E2404) continua NOT_FOUND.
    next[`GET /dps/${DPS_ID}`] = { status: 404, raw: '{"tipoAmbiente":0,"erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e com o identificador de DPS informado"}}' };
    expect(await gateway().findByDpsId(DPS_ID, context())).toEqual({ kind: 'NOT_FOUND' });
  });

  it('403 com código (certificado da transmissão) → REJECTED; sem código → UNKNOWN', async () => {
    next['POST /nfse'] = { status: 403, body: { ...meta, erros: [{ codigo: 'E1203', descricao: 'Certificado' }] } };
    expect(await gateway().submit(DPS, context())).toMatchObject({ kind: 'REJECTED', code: 'E1203' });
    next['POST /nfse'] = { status: 403, raw: '<html>proibido</html>' };
    expect(await gateway().submit(DPS, context())).toEqual({ kind: 'UNKNOWN', errorCode: 'HTTP_403' });
  });

  it.each<[string, Reply, string]>([
    ['500 do autorizador', { status: 500, body: { ...meta, erros: [{ codigo: 'E9999', descricao: 'falha' }] } }, 'HTTP_500'],
    ['400 sem código Exxxx', { status: 400, body: { ...meta, erros: [{ codigo: 'X1', descricao: '?' }] } }, 'HTTP_400'],
    ['201 ilegível', { status: 201, raw: 'não é json' }, 'RESPONSE_UNREADABLE'],
    ['201 sem o XML', { status: 201, body: { ...meta, chaveAcesso: KEY } }, 'RESPONSE_UNREADABLE'],
    ['201 de outra DPS', { status: 201, body: { ...meta, idDps: `DPS${'9'.repeat(42)}`, chaveAcesso: KEY, nfseXmlGZipB64: gz(NFSE) } }, 'RESPONSE_DPS_MISMATCH'],
    ['status não documentado', { status: 302 }, 'HTTP_302'],
  ])('%s → UNKNOWN (nunca "não emitida")', async (_name, reply, code) => {
    next['POST /nfse'] = reply;
    expect(await gateway().submit(DPS, context())).toEqual({ kind: 'UNKNOWN', errorCode: code });
  });

  it('servidor recebe e não responde → UNKNOWN; porta fechada → NOT_SENT; ambiente sem URL → NOT_SENT sem rede', async () => {
    next['POST /nfse'] = { status: 0, hang: true };
    expect((await gateway().submit(DPS, context())).kind).toBe('UNKNOWN');
    expect((await gateway('https://localhost:1/SefinNacional').submit(DPS, context())).kind).toBe('NOT_SENT');
    seen = [];
    const production = await gateway().submit(DPS, { ...context(), environment: 'PRODUCTION' });
    expect(production).toEqual({ kind: 'NOT_SENT', errorCode: 'NFSE_ENVIRONMENT_NOT_CONFIGURED' });
    expect(seen).toEqual([]);
  });
});

describe('NationalNfseGateway.findByDpsId (GET /dps/{id} → GET /nfse/{chave})', () => {
  it('encontrada: chave pela DPS e XML pela chave', async () => {
    next[`GET /dps/${DPS_ID}`] = { status: 200, body: { ...meta, idDps: DPS_ID, chaveAcesso: KEY } };
    next[`GET /nfse/${KEY}`] = { status: 200, body: { ...meta, chaveAcesso: KEY, nfseXmlGZipB64: gz(NFSE) } };
    expect(await gateway().findByDpsId(DPS_ID, context())).toEqual({ kind: 'FOUND', accessKey: KEY, nfseXml: NFSE });
  });

  it('404 → NOT_FOUND; DPS existe mas a NFS-e falha → ERROR (nunca NOT_FOUND); 500 → ERROR', async () => {
    expect(await gateway().findByDpsId(DPS_ID, context())).toEqual({ kind: 'NOT_FOUND' });
    next[`GET /dps/${DPS_ID}`] = { status: 200, body: { ...meta, chaveAcesso: KEY } };
    next[`GET /nfse/${KEY}`] = { status: 500, body: {} };
    expect(await gateway().findByDpsId(DPS_ID, context())).toEqual({ kind: 'ERROR', errorCode: 'HTTP_500' });
    next[`GET /dps/${DPS_ID}`] = { status: 500, body: {} };
    expect(await gateway().findByDpsId(DPS_ID, context())).toEqual({ kind: 'ERROR', errorCode: 'HTTP_500' });
  });
});

describe('NationalNfseGateway: eventos', () => {
  it('registro: envia { pedidoRegistroEventoXmlGZipB64 } e devolve o evento', async () => {
    next[`POST /nfse/${KEY}/eventos`] = { status: 201, body: { ...meta, eventoXmlGZipB64: gz(EVENT) } };
    expect(await gateway().registerEvent(KEY, '<pedRegEvento/>', context())).toEqual({ kind: 'REGISTERED', eventXml: EVENT });
    const sent = JSON.parse(seen[0]?.body ?? '{}') as Record<string, string>;
    expect(Object.keys(sent)).toEqual(['pedidoRegistroEventoXmlGZipB64']);
    expect(sent.pedidoRegistroEventoXmlGZipB64).toBe(pack('<pedRegEvento/>'));
  });

  it('400 E0840 ou E0802 (já existe) → ALREADY_EXISTS; outro Exxxx (formato `erro` singular) → REJECTED; 500 → UNKNOWN', async () => {
    for (const codigo of ['E0840', 'E0802']) {
      next[`POST /nfse/${KEY}/eventos`] = { status: 400, body: { ...meta, erro: { codigo, descricao: 'já existe' } } };
      expect(await gateway().registerEvent(KEY, '<p/>', context())).toEqual({ kind: 'ALREADY_EXISTS' });
    }
    next[`POST /nfse/${KEY}/eventos`] = { status: 400, body: { ...meta, erro: { codigo: 'E0822', descricao: 'Prazo expirou' } } };
    expect(await gateway().registerEvent(KEY, '<p/>', context())).toEqual({ kind: 'REJECTED', code: 'E0822', message: 'E0822: Prazo expirou' });
    next[`POST /nfse/${KEY}/eventos`] = { status: 500, body: {} };
    expect(await gateway().registerEvent(KEY, '<p/>', context())).toEqual({ kind: 'UNKNOWN', errorCode: 'HTTP_500' });
  });

  it('consulta usa o número sequencial na rota; 404 → NOT_FOUND', async () => {
    next[`GET /nfse/${KEY}/eventos/101101/1`] = { status: 200, body: { ...meta, eventoXmlGZipB64: gz(EVENT) } };
    expect(await gateway().findEvent(KEY, '101101', 1, context())).toEqual({ kind: 'FOUND', eventXml: EVENT });
    expect(await gateway().findEvent(KEY, '105102', 1, context())).toEqual({ kind: 'NOT_FOUND' });
    expect(await gateway().findEvent(KEY, '101101', 0, context())).toEqual({ kind: 'ERROR', errorCode: 'EVENT_QUERY_INVALID' });
    expect(seen.map((s) => s.path)).toEqual([`/nfse/${KEY}/eventos/101101/1`, `/nfse/${KEY}/eventos/105102/1`]);
  });
});

describe('perfil da SEFIN Nacional', () => {
  it('só a produção restrita, com o basePath do Swagger', () => {
    expect(SEFIN_NACIONAL.baseUrls).toEqual({ HOMOLOGATION: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional' });
  });
});
