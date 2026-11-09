import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KeyMaterialSource, SecretHasher } from '../../application/ports.js';

/** Tamanho mínimo do pepper: 256 bits. */
export const MIN_PEPPER_BYTES = 32;

/**
 * HMAC-SHA256 do segredo com um pepper que NÃO fica no banco (ADR-0012): um dump do banco
 * sozinho não permite testar segredos offline.
 */
export class HmacSecretHasher implements SecretHasher {
  private readonly pepper: Buffer;

  constructor(pepper: Uint8Array) {
    if (pepper.length < MIN_PEPPER_BYTES) throw new Error(`pepper deve ter ao menos ${MIN_PEPPER_BYTES} bytes`);
    this.pepper = Buffer.from(pepper);
  }

  hash(secret: string): Uint8Array {
    return createHmac('sha256', this.pepper).update(secret, 'utf8').digest();
  }

  matches(secret: string, expectedHash: Uint8Array): boolean {
    const actual = createHmac('sha256', this.pepper).update(secret, 'utf8').digest();
    return expectedHash.length === actual.length && timingSafeEqual(actual, expectedHash);
  }

  /** Evita que o pepper apareça se o objeto for serializado ou inspecionado. */
  toJSON(): string {
    return '[HmacSecretHasher]';
  }
}

export class RandomKeyMaterial implements KeyMaterialSource {
  keyId(): string {
    return randomBytes(8).toString('hex');
  }

  secret(): string {
    return randomBytes(32).toString('base64url');
  }
}

/**
 * Lê o pepper de um arquivo montado só no container que precisa dele (docs/architecture/13 §6).
 * A mensagem de erro nunca contém o conteúdo do arquivo.
 */
export function loadPepperFile(path: string): Buffer {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new Error('não foi possível ler o arquivo do pepper das API keys (API_KEY_PEPPER_FILE)');
  }
  const trimmed = Buffer.from(content.toString('utf8').trim(), 'utf8');
  if (trimmed.length < MIN_PEPPER_BYTES) {
    throw new Error(`o pepper das API keys deve ter ao menos ${MIN_PEPPER_BYTES} bytes`);
  }
  return trimmed;
}
