import { constants, createHash, createHmac, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { InternalError } from '../../../../shared/application/errors.js';
import type { SealedSecret, SecretBinding, SecretGenerator, SecretOpener, SecretSealer, WebhookSigner } from '../../application/ports.js';

/**
 * Segredos de assinatura de webhook (docs/architecture/09 §3, ADR-0021).
 *
 * Cifrados com RSA-OAEP/SHA-256 usando a chave PÚBLICA da plataforma (a API cifra e não lê
 * mais). O rótulo OAEP amarra o ciphertext à empresa, à assinatura e à versão: copiar o valor
 * para outra linha faz a abertura falhar. Só o worker-general tem a chave privada.
 */
const LABEL_PREFIX = 'orbita-nfe/webhook-secret/v1';
const MIN_KEY_BITS = 3072;
export const SECRET_PREFIX = 'whsec_';

const label = (b: SecretBinding): Buffer => Buffer.from(`${LABEL_PREFIX}|${b.companyId}|${b.subscriptionId}|${b.version}`, 'utf8');

/** Identificador da chave (16 hex do SHA-256 do SPKI), para rotação. */
export function webhookKekIdOf(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

function assertRsa(key: KeyObject, type: 'public' | 'private'): void {
  if (key.type !== type) throw new Error(`a chave de segredos de webhook deve ser ${type === 'public' ? 'pública' : 'privada'}`);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('a chave de segredos de webhook deve ser RSA');
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_KEY_BITS) throw new Error(`a chave de segredos de webhook deve ter ao menos ${MIN_KEY_BITS} bits`);
}

export class RsaSecretSealer implements SecretSealer {
  private readonly kekId: string;
  constructor(private readonly publicKey: KeyObject) {
    assertRsa(publicKey, 'public');
    this.kekId = webhookKekIdOf(publicKey);
  }

  seal(secret: string, binding: SecretBinding): SealedSecret {
    const ciphertext = publicEncrypt(
      { key: this.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label(binding) },
      Buffer.from(secret, 'utf8'),
    );
    return { ciphertext, kekId: this.kekId };
  }
}

/** Aceita várias chaves privadas (rotação): escolhe pelo `kekId` gravado. */
export class RsaSecretOpener implements SecretOpener {
  private readonly keys = new Map<string, KeyObject>();
  constructor(privateKeys: readonly KeyObject[]) {
    if (privateKeys.length === 0) throw new Error('informe ao menos uma chave privada de segredos de webhook');
    for (const key of privateKeys) {
      assertRsa(key, 'private');
      this.keys.set(webhookKekIdOf(key), key);
    }
  }

  open(sealed: SealedSecret, binding: SecretBinding): string {
    const key = this.keys.get(sealed.kekId);
    if (key === undefined) throw new InternalError('WEBHOOK_SECRET_KEY_UNAVAILABLE');
    try {
      return privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label(binding) }, sealed.ciphertext).toString('utf8');
    } catch {
      throw new InternalError('WEBHOOK_SECRET_UNSEALABLE');
    }
  }
}

export const randomSecretGenerator: SecretGenerator = {
  generate: () => SECRET_PREFIX + randomBytes(32).toString('base64'),
};

/**
 * Assinatura no formato Standard Webhooks (https://www.standardwebhooks.com):
 * `webhook-signature: v1,<base64(HMAC-SHA256(chave, "<id>.<timestamp>.<corpo>"))>`, onde a
 * chave são os bytes do base64 que vem depois de `whsec_`.
 */
export const standardWebhookSigner: WebhookSigner = {
  sign(secret, webhookId, timestampSeconds, body) {
    if (!secret.startsWith(SECRET_PREFIX)) throw new InternalError('WEBHOOK_SECRET_MALFORMED');
    const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
    const mac = createHmac('sha256', key).update(`${webhookId}.${timestampSeconds}.${body}`, 'utf8').digest('base64');
    return `v1,${mac}`;
  },
};
