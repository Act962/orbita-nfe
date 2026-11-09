import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from './config.js';

const REQUIRED = { DATABASE_URL: 'postgres://app_api:x@localhost:5432/orbita_nfe', API_KEY_PEPPER_FILE: '/run/secrets/api-key-pepper' };

describe('loadConfig', () => {
  it('aplica padrões seguros', () => {
    const config = loadConfig(REQUIRED);
    expect(config).toMatchObject({ NODE_ENV: 'development', HTTP_PORT: 3000, LOG_LEVEL: 'info', API_DOCS_ENABLED: true, DATABASE_POOL_MAX: 10 });
  });

  it('API_DOCS_ENABLED aceita apenas true/false', () => {
    expect(loadConfig({ ...REQUIRED, API_DOCS_ENABLED: 'false' }).API_DOCS_ENABLED).toBe(false);
    expect(() => loadConfig({ ...REQUIRED, API_DOCS_ENABLED: 'sim' })).toThrow(InvalidConfigError);
  });

  it('DATABASE_URL é obrigatória e deve ser postgres://', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('API_KEY_PEPPER_FILE é obrigatório', () => {
    expect(() => loadConfig({ DATABASE_URL: REQUIRED.DATABASE_URL })).toThrow(/API_KEY_PEPPER_FILE/);
  });

  it('falha na carga com configuração inválida, sem expor o valor recebido', () => {
    let error: unknown;
    try {
      loadConfig({ ...REQUIRED, HTTP_PORT: 'segredo-colado-por-engano', NODE_ENV: 'prod' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidConfigError);
    const message = (error as Error).message;
    expect(message).toContain('HTTP_PORT');
    expect(message).toContain('NODE_ENV');
    expect(message).not.toContain('segredo-colado-por-engano');
  });
});
