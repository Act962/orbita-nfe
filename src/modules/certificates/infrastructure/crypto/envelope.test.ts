import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeError, KekError, RsaEnvelopeOpener, RsaEnvelopeSealer, kekIdOf, loadPrivateKek, loadPublicKek } from './envelope.js';

let kek: { publicKey: KeyObject; privateKey: KeyObject };
let otherKek: { publicKey: KeyObject; privateKey: KeyObject };
const binding = { companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20', certificateId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b21' };
const material = () => ({ pfx: Buffer.from('CONTEUDO-DO-PFX'), password: Buffer.from('senha-secreta') });

beforeAll(() => {
  kek = generateKeyPairSync('rsa', { modulusLength: 4096 });
  otherKek = generateKeyPairSync('rsa', { modulusLength: 4096 });
});

describe('envelope de certificados (ADR-0009)', () => {
  it('cifra com a KEK pública e só abre com a privada correspondente', () => {
    const sealed = new RsaEnvelopeSealer(kek.publicKey).seal(material(), binding);
    expect(sealed.kekId).toBe(kekIdOf(kek.publicKey));
    expect(sealed.pfxSealed.includes(Buffer.from('CONTEUDO-DO-PFX'))).toBe(false);
    expect(sealed.passwordSealed.includes(Buffer.from('senha-secreta'))).toBe(false);
    const opened = new RsaEnvelopeOpener([kek.privateKey]).open(sealed, binding);
    expect(opened.pfx.toString()).toBe('CONTEUDO-DO-PFX');
    expect(opened.password.toString()).toBe('senha-secreta');
  });

  it('cada envelope tem DEK e IV próprios', () => {
    const sealer = new RsaEnvelopeSealer(kek.publicKey);
    const a = sealer.seal(material(), binding);
    const b = sealer.seal(material(), binding);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
    expect(a.pfxSealed.equals(b.pfxSealed)).toBe(false);
  });

  it('AAD: blob movido para outra empresa ou outro certificado não abre', () => {
    const sealed = new RsaEnvelopeSealer(kek.publicKey).seal(material(), binding);
    const opener = new RsaEnvelopeOpener([kek.privateKey]);
    expect(() => opener.open(sealed, { ...binding, companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b99' })).toThrow(EnvelopeError);
    expect(() => opener.open(sealed, { ...binding, certificateId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b99' })).toThrow(EnvelopeError);
  });

  it('PFX e senha não podem ser trocados entre si nem adulterados', () => {
    const sealed = new RsaEnvelopeSealer(kek.publicKey).seal(material(), binding);
    const opener = new RsaEnvelopeOpener([kek.privateKey]);
    expect(() => opener.open({ ...sealed, pfxSealed: sealed.passwordSealed }, binding)).toThrow(EnvelopeError);
    const tampered = Buffer.from(sealed.pfxSealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => opener.open({ ...sealed, pfxSealed: tampered }, binding)).toThrow(EnvelopeError);
  });

  it('KEK desconhecida → ENVELOPE_KEK_UNKNOWN; rotação aceita mais de uma KEK', () => {
    const sealed = new RsaEnvelopeSealer(otherKek.publicKey).seal(material(), binding);
    expect(() => new RsaEnvelopeOpener([kek.privateKey]).open(sealed, binding)).toThrow(expect.objectContaining({ code: 'ENVELOPE_KEK_UNKNOWN' }));
    expect(new RsaEnvelopeOpener([kek.privateKey, otherKek.privateKey]).open(sealed, binding).pfx.toString()).toBe('CONTEUDO-DO-PFX');
  });

  it('o erro de decifragem não carrega a causa do OpenSSL', () => {
    const sealed = new RsaEnvelopeSealer(kek.publicKey).seal(material(), binding);
    try {
      new RsaEnvelopeOpener([kek.privateKey]).open({ ...sealed, wrappedDek: Buffer.alloc(512) }, binding);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeError);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('carga da KEK', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kek-'));
  const write = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('a API recusa arquivo com chave privada no lugar da pública', () => {
    const path = write('priv.pem', kek.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    expect(() => loadPublicKek(path)).toThrow(expect.objectContaining({ code: 'KEK_NOT_PUBLIC' }));
    expect(loadPrivateKek(path).type).toBe('private');
  });

  it('exige RSA de pelo menos 4096 bits', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const path = write('small.pem', small.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    expect(() => loadPublicKek(path)).toThrow(expect.objectContaining({ code: 'KEK_TOO_SMALL' }));
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => loadPublicKek(write('ec.pem', ec.publicKey.export({ type: 'spki', format: 'pem' }).toString()))).toThrow(KekError);
  });

  it('arquivo ausente → KEK_FILE_UNREADABLE (sem o caminho na mensagem)', () => {
    expect(() => loadPublicKek(join(dir, 'nao-existe.pem'))).toThrow(expect.objectContaining({ code: 'KEK_FILE_UNREADABLE', message: 'KEK_FILE_UNREADABLE' }));
  });
});
