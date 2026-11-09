import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('aplica padrões seguros', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ NODE_ENV: 'development', HTTP_PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('falha na carga com configuração inválida, sem expor o valor recebido', () => {
    let error: unknown;
    try {
      loadConfig({ HTTP_PORT: 'segredo-colado-por-engano', NODE_ENV: 'prod' });
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
