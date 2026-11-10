import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CertificateMaterial, CertificateOpener, CertificateSealer, EnvelopeBinding, SealedCertificate } from '../../application/ports.js';

/**
 * Criptografia por envelope (ADR-0009, docs/architecture/13 §3):
 * - DEK aleatória de 256 bits por certificado; PFX e senha cifrados separadamente com
 *   AES-256-GCM, IV de 96 bits, AAD = versão ‖ empresa ‖ certificado ‖ finalidade;
 * - DEK embrulhada com a KEK pública (RSA-OAEP, SHA-256, chave de 4096 bits);
 * - formato de cada campo: IV (12) ‖ tag (16) ‖ ciphertext.
 * A API carrega só a KEK pública; a privada existe só no worker-fiscal.
 */
export const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
export const KEK_MIN_BITS = 4096;

export class KekError extends Error {
  constructor(readonly code: 'KEK_FILE_UNREADABLE' | 'KEK_NOT_PUBLIC' | 'KEK_NOT_PRIVATE' | 'KEK_NOT_RSA' | 'KEK_TOO_SMALL' | 'KEK_ID_MISMATCH') {
    super(code);
    this.name = 'KekError';
  }
}

export class EnvelopeError extends Error {
  constructor(readonly code: 'ENVELOPE_VERSION_UNSUPPORTED' | 'ENVELOPE_KEK_UNKNOWN' | 'ENVELOPE_CORRUPTED') {
    super(code);
    this.name = 'EnvelopeError';
  }
}

function aad(binding: EnvelopeBinding, purpose: 'pfx' | 'password'): Buffer {
  return Buffer.from(`orbita-nfe/certificate/v${ENVELOPE_VERSION}|${binding.companyId}|${binding.certificateId}|${purpose}`, 'utf8');
}

function encrypt(dek: Buffer, plaintext: Buffer, additional: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additional);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(dek: Buffer, sealed: Buffer, additional: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new EnvelopeError('ENVELOPE_CORRUPTED');
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, sealed.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(additional);
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    // Sem a causa: a mensagem do OpenSSL não ajuda e não deve ir para log.
    throw new EnvelopeError('ENVELOPE_CORRUPTED');
  }
}

/** Identificador estável da KEK: SHA-256 do SPKI DER, 16 primeiros hexadecimais. */
export function kekIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function assertRsa4096(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'rsa') throw new KekError('KEK_NOT_RSA');
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < KEK_MIN_BITS) throw new KekError('KEK_TOO_SMALL');
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new KekError('KEK_FILE_UNREADABLE');
  }
}

/** KEK pública (PEM SPKI). Recusa arquivo que contenha chave privada: a API não pode tê-la. */
export function loadPublicKek(path: string): KeyObject {
  const pem = readKeyFile(path);
  if (/PRIVATE KEY/.test(pem)) throw new KekError('KEK_NOT_PUBLIC');
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new KekError('KEK_NOT_PUBLIC');
  }
  assertRsa4096(key);
  return key;
}

/** KEK privada (PEM PKCS#8). Só o worker-fiscal chama esta função. */
export function loadPrivateKek(path: string): KeyObject {
  const pem = readKeyFile(path);
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new KekError('KEK_NOT_PRIVATE');
  }
  if (key.type !== 'private') throw new KekError('KEK_NOT_PRIVATE');
  assertRsa4096(key);
  return key;
}

export class RsaEnvelopeSealer implements CertificateSealer {
  readonly kekId: string;

  constructor(private readonly publicKek: KeyObject) {
    assertRsa4096(publicKek);
    this.kekId = kekIdOf(publicKek);
  }

  seal(material: CertificateMaterial, binding: EnvelopeBinding): SealedCertificate {
    const dek = randomBytes(DEK_BYTES);
    try {
      return {
        envelopeVersion: ENVELOPE_VERSION,
        kekId: this.kekId,
        wrappedDek: publicEncrypt({ key: this.publicKek, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dek),
        pfxSealed: encrypt(dek, material.pfx, aad(binding, 'pfx')),
        passwordSealed: encrypt(dek, material.password, aad(binding, 'password')),
      };
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * Aceita mais de uma KEK privada durante a rotação (re-wrap das DEKs, doc 13 §6): o envelope
 * diz qual `kekId` usar.
 */
export class RsaEnvelopeOpener implements CertificateOpener {
  private readonly keys: ReadonlyMap<string, KeyObject>;

  constructor(privateKeks: readonly KeyObject[]) {
    this.keys = new Map(privateKeks.map((key) => [kekIdOf(createPublicKey(key)), key]));
  }

  open(sealed: SealedCertificate, binding: EnvelopeBinding): CertificateMaterial {
    if (sealed.envelopeVersion !== ENVELOPE_VERSION) throw new EnvelopeError('ENVELOPE_VERSION_UNSUPPORTED');
    const key = this.keys.get(sealed.kekId);
    if (key === undefined) throw new EnvelopeError('ENVELOPE_KEK_UNKNOWN');
    let dek: Buffer;
    try {
      dek = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, sealed.wrappedDek);
    } catch {
      throw new EnvelopeError('ENVELOPE_CORRUPTED');
    }
    try {
      const pfx = decrypt(dek, sealed.pfxSealed, aad(binding, 'pfx'));
      try {
        return { pfx, password: decrypt(dek, sealed.passwordSealed, aad(binding, 'password')) };
      } catch (error) {
        pfx.fill(0);
        throw error;
      }
    } finally {
      dek.fill(0);
    }
  }
}
