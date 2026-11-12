import { createPrivateKey } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../../../../test/support/tls-test-pki.js';
import { createMtlsAgent, sendOnce, type MtlsIdentity, type TransportLimits } from './mtls-transport.js';

const LIMITS: TransportLimits = { connectTimeoutMs: 2000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, maxResponseBytes: 64 * 1024 };
const XML = '<DPS><infDPS Id="x">teste</infDPS></DPS>';

let pki: TestPki;
let server: Server;
let baseUrl: string;
/** Quantas requisições o "autorizador" de teste realmente recebeu, por rota. */
const received: Record<string, number> = {};

beforeAll(async () => {
  pki = createTestPki();
  server = createServer(
    { key: pki.server.keyPem, cert: pki.server.certPem, ca: pki.ca.caCertPem, requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const path = req.url ?? '/';
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received[path] = (received[path] ?? 0) + 1;
        if (path === '/ok') res.writeHead(200, { 'x-teste': 'sim' }).end(`<ret><len>${body.length}</len><m>${req.method}</m></ret>`);
        else if (path === '/http-500') res.writeHead(500).end('erro interno');
        else if (path === '/hang') return; // processa e nunca responde
        else if (path === '/reset-after-body') req.socket.destroy(); // processa e derruba a conexão
        else if (path === '/partial-body') {
          res.writeHead(200, { 'content-length': '1000' });
          res.write('<ret>');
          setTimeout(() => req.socket.destroy(), 50);
        } else if (path === '/huge') res.end('x'.repeat(200 * 1024));
        else res.writeHead(404).end();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function identity(kind: 'client' | 'intruder' = 'client', trustServer = true): MtlsIdentity {
  const source = kind === 'client' ? pki.client : pki.otherCa;
  return {
    privateKey: createPrivateKey(source.keyPem),
    certificatePem: source.certPem,
    serverTrustPem: trustServer ? pki.ca.caCertPem : pki.otherCa.caCertPem,
  };
}

const post = (path: string, id = identity()) =>
  sendOnce(createMtlsAgent(id, LIMITS), { method: 'POST', url: path.startsWith('https') ? path : `${baseUrl}${path}`, body: XML, headers: { 'content-type': 'application/json' } }, LIMITS);

describe('sendOnce com mTLS: classificação da fase da falha (ADR-0022)', () => {
  it('sucesso: devolve status, cabeçalhos e corpo', async () => {
    const outcome = await post('/ok');
    expect(outcome).toMatchObject({ kind: 'RESPONSE', status: 200, body: `<ret><len>${XML.length}</len><m>POST</m></ret>` });
    expect(outcome.kind === 'RESPONSE' && outcome.headers['x-teste']).toBe('sim');
  });

  it('GET e HEAD sem corpo', async () => {
    const agent = createMtlsAgent(identity(), LIMITS);
    expect(await sendOnce(agent, { method: 'GET', url: `${baseUrl}/ok` }, LIMITS)).toMatchObject({ kind: 'RESPONSE', status: 200 });
    expect(await sendOnce(agent, { method: 'HEAD', url: `${baseUrl}/ok` }, LIMITS)).toMatchObject({ kind: 'RESPONSE', status: 200, body: '' });
  });

  it('HTTP 500 é resposta: a política de UNKNOWN fica no gateway', async () => {
    expect(await post('/http-500')).toMatchObject({ kind: 'RESPONSE', status: 500 });
  });

  it.each([
    ['porta fechada', 'https://localhost:1/ok'],
    ['DNS inexistente', 'https://autorizador.invalid/ok'],
  ])('%s → NOT_SENT', async (_name, url) => {
    expect(await post(url)).toMatchObject({ kind: 'NOT_SENT', phase: 'connect' });
  });

  it('certificado do SERVIDOR não confiável → NOT_SENT, e o servidor não recebe nada', async () => {
    const before = received['/ok'] ?? 0;
    expect(await post('/ok', identity('client', false))).toMatchObject({ kind: 'NOT_SENT', phase: 'connect' });
    expect(received['/ok'] ?? 0).toBe(before);
  });

  it('certificado do CLIENTE recusado → nunca RESPONSE, e o servidor não processa', async () => {
    const before = received['/ok'] ?? 0;
    const outcome = await post('/ok', identity('intruder'));
    expect(outcome.kind).not.toBe('RESPONSE');
    expect(received['/ok'] ?? 0).toBe(before);
  });

  it('servidor processa e não responde → UNKNOWN/response-wait, recebido exatamente 1 vez', async () => {
    expect(await post('/hang')).toMatchObject({ kind: 'UNKNOWN', phase: 'response-wait' });
    expect(received['/hang']).toBe(1);
  });

  it('servidor processa e derruba a conexão → UNKNOWN, sem retentativa automática', async () => {
    expect((await post('/reset-after-body')).kind).toBe('UNKNOWN');
    await new Promise((r) => setTimeout(r, 300));
    expect(received['/reset-after-body']).toBe(1);
  });

  it('resposta cortada → UNKNOWN/response-read', async () => {
    expect(await post('/partial-body')).toMatchObject({ kind: 'UNKNOWN', phase: 'response-read' });
  });

  it('resposta acima do limite → UNKNOWN/response-read (RESPONSE_TOO_LARGE)', async () => {
    expect(await post('/huge')).toEqual({ kind: 'UNKNOWN', phase: 'response-read', errorCode: 'RESPONSE_TOO_LARGE' });
  });

  it('requisições concorrentes não misturam traces', async () => {
    const agent = createMtlsAgent(identity(), LIMITS);
    const send = (url: string) => sendOnce(agent, { method: 'POST', url, body: XML }, LIMITS);
    const results = await Promise.all([send(`${baseUrl}/ok`), send('https://localhost:1/ok'), send(`${baseUrl}/hang`), send(`${baseUrl}/ok`)]);
    expect(results.map((r) => r.kind)).toEqual(['RESPONSE', 'NOT_SENT', 'UNKNOWN', 'RESPONSE']);
  });

  it('o resultado não carrega mensagem de erro, só o código', async () => {
    const outcome = await post('https://autorizador.invalid/ok');
    expect(Object.keys(outcome).sort()).toEqual(['errorCode', 'kind', 'phase']);
  });
});
