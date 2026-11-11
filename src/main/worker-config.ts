import { z } from 'zod';
import { anchorConfigState, anchorEnvShape } from './anchor-config.js';

/**
 * Configuração dos workers (fail fast). Cada worker recebe SÓ os segredos do seu papel
 * (ADR-0021): o worker-fiscal recusa a chave de webhooks e o worker-general recusa a KEK dos
 * certificados. Segredos vêm de arquivos montados, nunca do valor em variável de ambiente.
 */
const booleanFromEnv = z.enum(['true', 'false']).transform((v) => v === 'true');
const postgresUrl = z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://');

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  JOB_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
};

/** Em produção, cada container recebe só os próprios segredos: variável de outro papel = erro. */
const notInProduction = (name: string) => (c: { NODE_ENV: string } & Record<string, unknown>) => !(c.NODE_ENV === 'production' && c[name] !== undefined);

const FiscalWorkerSchema = z
  .object({
    ...common,
    /** Login membro de fiscal_worker. */
    WORKER_DATABASE_URL: postgresUrl,
    WORKER_CERTIFICATE_KEK_PRIVATE_FILE: z.string().min(1),
    CERTIFICATE_TRUST_BUNDLE_FILE: z.string().min(1),
    WEBHOOK_SECRET_KEY_PRIVATE_FILE: z.undefined({ error: 'a chave de webhooks não pode ser configurada no worker-fiscal' }).optional(),
    GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: z.string().optional(),
  })
  .refine(notInProduction('GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE'), {
    path: ['GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE'],
    message: 'a chave de webhooks não pode estar no container do worker-fiscal',
  });

const GeneralWorkerSchema = z
  .object({
    ...common,
    /** Login membro de fiscal_general. */
    GENERAL_DATABASE_URL: postgresUrl,
    GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE: z.string().min(1),
    WEBHOOK_ALLOW_PRIVATE_TARGETS: booleanFromEnv.default(false),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    ...anchorEnvShape,
    CERTIFICATE_KEK_PRIVATE_FILE: z.undefined({ error: 'a KEK de certificados não pode ser configurada no worker-general' }).optional(),
    WORKER_CERTIFICATE_KEK_PRIVATE_FILE: z.string().optional(),
  })
  .refine((c) => !(c.NODE_ENV === 'production' && c.WEBHOOK_ALLOW_PRIVATE_TARGETS), {
    path: ['WEBHOOK_ALLOW_PRIVATE_TARGETS'],
    message: 'não pode ser true em produção (proteção contra SSRF)',
  })
  .refine(notInProduction('WORKER_CERTIFICATE_KEK_PRIVATE_FILE'), {
    path: ['WORKER_CERTIFICATE_KEK_PRIVATE_FILE'],
    message: 'a KEK de certificados não pode estar no container do worker-general',
  })
  .refine((c) => anchorConfigState(c) !== 'partial', {
    path: ['AUDIT_ANCHOR_S3_ENDPOINT'],
    message: 'âncora de auditoria configurada pela metade: informe endpoint, bucket e os dois arquivos de credencial',
  })
  .refine((c) => !(c.NODE_ENV === 'production' && anchorConfigState(c) !== 'configured'), {
    path: ['AUDIT_ANCHOR_S3_BUCKET'],
    message: 'obrigatória em produção: a âncora externa da auditoria (ADR-0031)',
  });

export type FiscalWorkerConfig = z.infer<typeof FiscalWorkerSchema>;
export type GeneralWorkerConfig = z.infer<typeof GeneralWorkerSchema>;

function parse<T>(schema: z.ZodType<T>, env: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Só o caminho e a mensagem, nunca o valor (pode ser um segredo mal colocado).
    throw new Error(`Configuração inválida:\n${parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}

export const loadFiscalWorkerConfig = (env: Record<string, string | undefined> = process.env): FiscalWorkerConfig => parse(FiscalWorkerSchema, env);
export const loadGeneralWorkerConfig = (env: Record<string, string | undefined> = process.env): GeneralWorkerConfig => parse(GeneralWorkerSchema, env);
