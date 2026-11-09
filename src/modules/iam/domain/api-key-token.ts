import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Formato da API key (ADR-0012, docs/architecture/09 §1):
 *
 *   fk_<ambiente>_<keyId>_<segredo>
 *
 * - ambiente: `live` (produção fiscal) ou `test` (homologação);
 * - keyId: 16 hexadecimais, identificador PÚBLICO usado para localizar a credencial;
 * - segredo: 32 bytes aleatórios (256 bits) em base64url sem padding (43 caracteres).
 *
 * Só o HMAC-SHA256 do segredo (com pepper) é armazenado. O token completo é exibido uma única vez.
 */
export type CredentialEnvironment = 'live' | 'test';

export interface ApiKeyToken {
  readonly environment: CredentialEnvironment;
  readonly keyId: string;
  readonly secret: string;
}

const TOKEN = /^fk_(live|test)_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
export const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parseApiKeyToken(raw: string): Result<ApiKeyToken, 'MALFORMED'> {
  const match = TOKEN.exec(raw);
  if (!match) return err('MALFORMED');
  const [, environment, keyId, secret] = match as unknown as [string, CredentialEnvironment, string, string];
  return ok({ environment, keyId, secret });
}

export function formatApiKeyToken(token: ApiKeyToken): string {
  if (!KEY_ID_PATTERN.test(token.keyId) || !SECRET_PATTERN.test(token.secret)) {
    throw new Error('componentes da API key fora do formato');
  }
  return `fk_${token.environment}_${token.keyId}_${token.secret}`;
}
