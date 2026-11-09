import { z } from 'zod';

/**
 * Configuração validada na inicialização (fail fast): o processo não sobe com config inválida.
 * Segredos (KEK, credenciais) NÃO passam por aqui: serão lidos de arquivos montados apenas
 * no container que precisa deles (docs/architecture/13 §6).
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HTTP_BODY_LIMIT: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
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
