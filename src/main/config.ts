import { z } from 'zod';

/**
 * Configuração validada na inicialização (fail fast): o processo não sobe com config inválida.
 * Segredos (KEK, credenciais) NÃO passam por aqui: serão lidos de arquivos montados apenas
 * no container que precisa deles (docs/architecture/13 §6).
 */
const booleanFromEnv = z.enum(['true', 'false']).transform((v) => v === 'true');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_BODY_LIMIT: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  API_DOCS_ENABLED: booleanFromEnv.default(true),
  /** Conexão do papel de aplicação (fiscal_api / fiscal_worker / ...), nunca do dono das tabelas. */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  /** Caminho do arquivo com o pepper das API keys (≥ 32 bytes). O conteúdo nunca passa por variável de ambiente. */
  API_KEY_PEPPER_FILE: z.string().min(1),
  /** KEK PÚBLICA dos certificados (PEM, RSA 4096). A API cifra e nunca decifra (ADR-0009). */
  CERTIFICATE_KEK_PUBLIC_FILE: z.string().min(1),
  /**
   * Proibida na API: a KEK privada existe só no worker-fiscal (docs/architecture/13 §9). Se
   * estiver configurada aqui, o processo não sobe.
   */
  CERTIFICATE_KEK_PRIVATE_FILE: z.undefined({ error: 'a KEK privada não pode ser configurada na API (só no worker-fiscal)' }).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Configuração inválida:\n${issues.join('\n')}`);
    this.name = 'InvalidConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    // Só o caminho e a mensagem: nunca o valor recebido (pode ser um segredo mal colocado).
    throw new InvalidConfigError(parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`));
  }
  return parsed.data;
}
