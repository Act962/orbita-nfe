import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPki, type TestPki } from '../support/test-pki.js';
import { openPkcs12 } from '../01-pkcs12-xmldsig/pkcs12.js';
import { createMtlsAgent, postOnce, type MtlsIdentity } from './transport.js';

const PASSWORD = 'CANARY-PASSWORD-7f3a91c2';
const TIMEOUTS = { connectMs: 2000, headersMs: 1000, bodyMs: 1000 };

let pki: TestPki;
let server: Server;
let baseUrl: string;
/** Quantas requisições o "autorizador" realmente recebeu, por rota. */
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
        if (path === '/ok') res.end(`<ret><cStat>100</cStat><len>${body.length}</len></ret>`);
        else if (path === '/http-500') res.writeHead(500).end('erro interno');
        else if (path === '/hang') return; // processa e nunca responde
        else if (path === '/reset-after-body') req.socket.destroy(); // processa e derruba a conexão
        else if (path === '/partial-body') {
          res.writeHead(200, { 'content-length': '1000' });
          res.write('<ret>');
          setTimeout(() => req.socket.destroy(), 50);
        }
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
  const opened = openPkcs12(pki.pfx(source, PASSWORD, 'aes256'), PASSWORD);
  return { privateKey: opened.privateKey, certificatePem: opened.certificatePem, trustedCaPem: trustServer ? pki.ca.caCertPem : pki.otherCa.caCertPem };
}

const XML = '<DPS><infDPS Id="x">teste</infDPS></DPS>';

describe('Spike 02 — mTLS com certificado A1 e classificação de falhas', () => {
  it('sucesso: mTLS com certificado do cliente aceito', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), `${baseUrl}/ok`, XML, 'application/xml');
    expect(outcome).toEqual({ kind: 'RESPONSE', status: 200, body: `<ret><cStat>100</cStat><len>${XML.length}</len></ret>` });
  });

  it('HTTP 500 é devolvido como resposta (a política UNKNOWN fica no gateway)', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), `${baseUrl}/http-500`, XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'RESPONSE', status: 500 });
  });

  it('porta fechada → NOT_SENT (pode retentar)', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), 'https://localhost:1/ok', XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'NOT_SENT', phase: 'connect' });
  });

  it('DNS inexistente → NOT_SENT', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), 'https://autorizador.invalid/ok', XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'NOT_SENT', phase: 'connect' });
  });

  it('certificado do SERVIDOR não confiável → NOT_SENT (handshake falha antes de enviar)', async () => {
    const before = received['/ok'] ?? 0;
    const outcome = await postOnce(createMtlsAgent(identity('client', false), TIMEOUTS), `${baseUrl}/ok`, XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'NOT_SENT', phase: 'connect' });
    expect(received['/ok'] ?? 0).toBe(before);
  });

  it('certificado do CLIENTE rejeitado pelo servidor → classificação registrada (ver achado no relatório)', async () => {
    const before = received['/ok'] ?? 0;
    const outcome = await postOnce(createMtlsAgent(identity('intruder'), TIMEOUTS), `${baseUrl}/ok`, XML, 'application/xml');
    expect(outcome.kind).not.toBe('RESPONSE');
    expect(received['/ok'] ?? 0).toBe(before); // servidor nunca processou
    // Registrado para o relatório: em TLS 1.3 o cliente pode já ter enviado a requisição.
    console.info(`[spike02] cliente rejeitado → ${JSON.stringify(outcome)}`);
  });

  it('servidor processa e não responde (timeout) → UNKNOWN/response-wait, recebido exatamente 1 vez', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), `${baseUrl}/hang`, XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'UNKNOWN', phase: 'response-wait' });
    expect(received['/hang']).toBe(1);
  });

  it('servidor processa e derruba a conexão → UNKNOWN, sem retentativa automática do undici', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), `${baseUrl}/reset-after-body`, XML, 'application/xml');
    expect(outcome.kind).toBe('UNKNOWN');
    await new Promise((r) => setTimeout(r, 300));
    expect(received['/reset-after-body']).toBe(1);
  });

  it('resposta cortada no meio do corpo → UNKNOWN/response-read', async () => {
    const outcome = await postOnce(createMtlsAgent(identity(), TIMEOUTS), `${baseUrl}/partial-body`, XML, 'application/xml');
    expect(outcome).toMatchObject({ kind: 'UNKNOWN', phase: 'response-read' });
  });

  it('requisições concorrentes não misturam traces', async () => {
    const agent = createMtlsAgent(identity(), TIMEOUTS);
    const results = await Promise.all([
      postOnce(agent, `${baseUrl}/ok`, XML, 'application/xml'),
      postOnce(agent, 'https://localhost:1/ok', XML, 'application/xml'),
      postOnce(agent, `${baseUrl}/hang`, XML, 'application/xml'),
      postOnce(agent, `${baseUrl}/ok`, XML, 'application/xml'),
    ]);
    expect(results.map((r) => r.kind)).toEqual(['RESPONSE', 'NOT_SENT', 'UNKNOWN', 'RESPONSE']);
  });
});
