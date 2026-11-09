import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HmacSecretHasher, loadPepperFile, RandomKeyMaterial } from './api-key-crypto.js';

const pepper = Buffer.alloc(32, 7);
const dir = mkdtempSync(join(tmpdir(), 'pepper-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HmacSecretHasher', () => {
  it('gera 32 bytes determinísticos e confere em tempo constante', () => {
    const hasher = new HmacSecretHasher(pepper);
    const hash = hasher.hash('segredo');
    expect(hash).toHaveLength(32);
    expect(hasher.matches('segredo', hash)).toBe(true);
    expect(hasher.matches('segredO', hash)).toBe(false);
  });

  it('pepper diferente → hash diferente (o banco sozinho não basta)', () => {
    const other = new HmacSecretHasher(Buffer.alloc(32, 8));
    expect(other.matches('segredo', new HmacSecretHasher(pepper).hash('segredo'))).toBe(false);
  });

  it('hash de tamanho errado não lança, só não confere', () => {
    expect(new HmacSecretHasher(pepper).matches('segredo', new Uint8Array(3))).toBe(false);
  });

  it('recusa pepper curto', () => {
    expect(() => new HmacSecretHasher(Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it('não expõe o pepper ao serializar', () => {
    const hasher = new HmacSecretHasher(Buffer.from('p'.repeat(40)));
    expect(JSON.stringify({ hasher })).not.toContain('pppp');
  });
});

describe('RandomKeyMaterial', () => {
  it('keyId com 16 hex e segredo de 256 bits em base64url', () => {
    const m = new RandomKeyMaterial();
    expect(m.keyId()).toMatch(/^[0-9a-f]{16}$/);
    const secret = m.secret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(m.secret()).not.toBe(secret);
  });
});

describe('loadPepperFile', () => {
  it('lê e remove espaços/quebra de linha', () => {
    const path = join(dir, 'ok');
    writeFileSync(path, `${'x'.repeat(40)}\n`);
    expect(loadPepperFile(path).toString()).toBe('x'.repeat(40));
  });

  it('arquivo curto → erro sem o conteúdo', () => {
    const path = join(dir, 'curto');
    writeFileSync(path, 'segredo-curto');
    expect(() => loadPepperFile(path)).toThrow(/ao menos 32 bytes/);
    try {
      loadPepperFile(path);
    } catch (error) {
      expect(String(error)).not.toContain('segredo-curto');
    }
  });

  it('arquivo ausente → erro sem o caminho', () => {
    expect(() => loadPepperFile(join(dir, 'nao-existe'))).toThrow(/API_KEY_PEPPER_FILE/);
  });
});
