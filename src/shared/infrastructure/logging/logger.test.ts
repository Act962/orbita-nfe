import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { sanitize } from './sanitize.js';
import { CANARIES, captureStream, expectNoCanary } from '../../../../test/support/canary.js';

describe('sanitize', () => {
  it('redige chaves sensíveis em qualquer profundidade', () => {
    const out = sanitize({ a: { b: { c: { certificatePassword: 'x', senha: 'y', apiKey: 'z', csc: 'w' } } } });
    expect(JSON.stringify(out)).not.toMatch(/"x"|"y"|"z"|"w"/);
  });

  it('nunca serializa bytes nem chaves criptográficas', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const out = sanitize({ payload: Buffer.from('bytes'), view: new Uint8Array([1, 2]), privateKey, k: privateKey });
    expect(out).toEqual({
      payload: '[REDACTED:Buffer]',
      view: '[REDACTED:Binary]',
      privateKey: '[REDACTED]',
      k: '[REDACTED:KeyObject]',
    });
  });

  it('lida com referências circulares e profundidade excessiva', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(sanitize(a)).toEqual({ self: '[Circular]' });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(JSON.stringify(sanitize(deep))).toContain('[Truncated]');
  });
});

// Teste canário (docs/architecture/13 §7): nenhum marcador secreto pode aparecer na saída.
describe('logger — teste canário', () => {
  it('não vaza segredos por objetos, erros, causas ou bindings', () => {
    const capture = captureStream();
    const logger = createLogger({ level: 'trace', service: 'test', destination: capture.stream });

    logger.info({ certificate: { password: CANARIES.password, pfx: Buffer.from(CANARIES.pfx) } }, 'upload');
    logger.child({ apiKey: CANARIES.apiKey }).warn('child com binding sensível');
    const cause = Object.assign(new Error('falha interna'), { passphrase: CANARIES.password });
    logger.error({ err: new Error('erro externo', { cause }), csc: CANARIES.csc }, 'com causa');
    logger.debug({ nested: [{ deep: { privateKey: CANARIES.privateKey } }] }, 'array');

    expect(capture.lines().length).toBe(4);
    expectNoCanary(capture.text());
  });
});
