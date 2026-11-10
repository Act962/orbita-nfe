import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { HttpWebhookSender } from '../http/webhook-sender.js';
import { RsaSecretOpener, RsaSecretSealer, SECRET_PREFIX, randomSecretGenerator, standardWebhookSigner, webhookKekIdOf } from './webhook-crypto.js';

let keys: { publicKey: KeyObject; privateKey: KeyObject };
let other: { publicKey: KeyObject; privateKey: KeyObject };
const binding = { companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20', subscriptionId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b21', version: 1 };

/** Código do InternalError lançado (a mensagem pública é genérica). */
function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

beforeAll(() => {
  keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  other = generateKeyPairSync('rsa', { modulusLength: 3072 });
});

describe('segredo de webhook cifrado (ADR-0021)', () => {
  it('a chave pública cifra; só a privada correspondente abre', () => {
    const secret = randomSecretGenerator.generate();
    const sealed = new RsaSecretSealer(keys.publicKey).seal(secret, binding);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(secret.slice(SECRET_PREFIX.length));
    expect(sealed.kekId).toBe(webhookKekIdOf(keys.privateKey));
    expect(new RsaSecretOpener([other.privateKey, keys.privateKey]).open(sealed, binding)).toBe(secret);
    expect(errorCode(() => new RsaSecretOpener([other.privateKey]).open(sealed, binding))).toBe('WEBHOOK_SECRET_KEY_UNAVAILABLE');
  });

  it('o ciphertext é amarrado à empresa, à assinatura e à versão', () => {
    const sealed = new RsaSecretSealer(keys.publicKey).seal(randomSecretGenerator.generate(), binding);
    const opener = new RsaSecretOpener([keys.privateKey]);
    expect(errorCode(() => opener.open(sealed, { ...binding, companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b99' }))).toBe('WEBHOOK_SECRET_UNSEALABLE');
    expect(errorCode(() => opener.open(sealed, { ...binding, subscriptionId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b99' }))).toBe('WEBHOOK_SECRET_UNSEALABLE');
    expect(errorCode(() => opener.open(sealed, { ...binding, version: 2 }))).toBe('WEBHOOK_SECRET_UNSEALABLE');
  });

  it('recusa chave pequena, não RSA ou do tipo errado', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => new RsaSecretSealer(small.publicKey)).toThrow(/bits/);
    expect(() => new RsaSecretSealer(ec.publicKey)).toThrow(/RSA/);
    expect(() => new RsaSecretSealer(keys.privateKey)).toThrow(/pública/);
    expect(() => new RsaSecretOpener([keys.publicKey])).toThrow(/privada/);
  });

  it('segredo novo a cada geração, com 32 bytes', () => {
    const a = randomSecretGenerator.generate();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(a.slice(SECRET_PREFIX.length), 'base64')).toHaveLength(32);
    expect(randomSecretGenerator.generate()).not.toBe(a);
  });
});

describe('assinatura Standard Webhooks', () => {
  it('confere com o vetor de teste publicado pela especificação', () => {
    // standard-webhooks (github.com/standard-webhooks/standard-webhooks), testes das bibliotecas oficiais.
    const signature = standardWebhookSigner.sign('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(signature).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('muda com qualquer alteração no id, no timestamp ou no corpo', () => {
    const secret = randomSecretGenerator.generate();
    const base = standardWebhookSigner.sign(secret, 'id', 1, '{}');
    expect(standardWebhookSigner.sign(secret, 'id2', 1, '{}')).not.toBe(base);
    expect(standardWebhookSigner.sign(secret, 'id', 2, '{}')).not.toBe(base);
    expect(standardWebhookSigner.sign(secret, 'id', 1, '{ }')).not.toBe(base);
  });
});

describe('envio HTTP com proteção contra SSRF', () => {
  it('fora do modo de desenvolvimento, nem tenta conectar em loopback, rede privada ou http', async () => {
    const sender = new HttpWebhookSender({ allowPrivateTargets: false, timeoutMs: 2000 });
    const signal = new AbortController().signal;
    try {
      for (const url of ['https://127.0.0.1:1/hook', 'https://169.254.169.254/x', 'http://exemplo.com.br/hook', 'https://localhost/hook']) {
        expect(await sender.send({ url, headers: {}, body: '{}' }, signal), url).toEqual({ kind: 'NETWORK_ERROR', code: 'TARGET_FORBIDDEN' });
      }
    } finally {
      await sender.close();
    }
  });
});
