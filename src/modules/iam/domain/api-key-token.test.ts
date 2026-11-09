import { describe, expect, it } from 'vitest';
import { formatApiKeyToken, parseApiKeyToken } from './api-key-token.js';

const secret = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const keyId = '0123456789abcdef';

describe('API key token', () => {
  it('formata e lê de volta', () => {
    const token = formatApiKeyToken({ environment: 'live', keyId, secret });
    expect(token).toBe(`fk_live_${keyId}_${secret}`);
    expect(parseApiKeyToken(token)).toEqual({ ok: true, value: { environment: 'live', keyId, secret } });
  });

  it('o segredo pode conter "_" sem confundir a separação', () => {
    const parsed = parseApiKeyToken(`fk_test_${keyId}_${secret}`);
    expect(parsed.ok && parsed.value.secret).toBe(secret);
  });

  it.each([
    ['vazio', ''],
    ['prefixo errado', `xx_live_${keyId}_${secret}`],
    ['ambiente desconhecido', `fk_prod_${keyId}_${secret}`],
    ['keyId curto', `fk_live_0123_${secret}`],
    ['keyId com maiúsculas', `fk_live_0123456789ABCDEF_${secret}`],
    ['segredo curto', `fk_live_${keyId}_abc`],
    ['segredo longo', `fk_live_${keyId}_${secret}x`],
    ['espaços', ` fk_live_${keyId}_${secret}`],
  ])('rejeita token malformado: %s', (_, raw) => {
    expect(parseApiKeyToken(raw)).toEqual({ ok: false, error: 'MALFORMED' });
  });

  it('não formata componentes inválidos', () => {
    expect(() => formatApiKeyToken({ environment: 'live', keyId: 'xyz', secret })).toThrow();
  });
});
