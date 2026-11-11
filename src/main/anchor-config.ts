import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { S3AnchorStoreOptions } from '../modules/audit/public.js';

/**
 * Bucket das âncoras de auditoria (ADR-0031). As credenciais vêm de ARQUIVOS montados, nunca do
 * valor em variável de ambiente. O worker-general recebe credencial de escrita; o operador, de leitura.
 */
export const anchorEnvShape = {
  AUDIT_ANCHOR_S3_ENDPOINT: z.url().optional(),
  AUDIT_ANCHOR_S3_REGION: z.string().min(1).default('us-east-1'),
  AUDIT_ANCHOR_S3_BUCKET: z.string().min(3).max(63).optional(),
  AUDIT_ANCHOR_S3_ACCESS_KEY_ID_FILE: z.string().min(1).optional(),
  AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY_FILE: z.string().min(1).optional(),
  AUDIT_ANCHOR_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Retenção COMPLIANCE de cada âncora. Padrão: 1830 dias (5 anos), decisão do ADR-0031. */
  AUDIT_ANCHOR_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(1830),
};

type AnchorEnv = z.infer<z.ZodObject<typeof anchorEnvShape>>;

const REQUIRED = ['AUDIT_ANCHOR_S3_ENDPOINT', 'AUDIT_ANCHOR_S3_BUCKET', 'AUDIT_ANCHOR_S3_ACCESS_KEY_ID_FILE', 'AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY_FILE'] as const;

/** Configurado = as quatro variáveis obrigatórias presentes. Metade configurado é erro. */
export function anchorConfigState(env: AnchorEnv): 'configured' | 'absent' | 'partial' {
  const present = REQUIRED.filter((name) => env[name] !== undefined).length;
  if (present === REQUIRED.length) return 'configured';
  return present === 0 ? 'absent' : 'partial';
}

const readSecretFile = (path: string): string => {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0) throw new Error(`arquivo de credencial vazio: ${path}`);
  return value;
};

export function anchorStoreOptions(env: AnchorEnv): S3AnchorStoreOptions | undefined {
  if (anchorConfigState(env) !== 'configured') return undefined;
  return {
    endpoint: env.AUDIT_ANCHOR_S3_ENDPOINT ?? '',
    region: env.AUDIT_ANCHOR_S3_REGION,
    bucket: env.AUDIT_ANCHOR_S3_BUCKET ?? '',
    accessKeyId: readSecretFile(env.AUDIT_ANCHOR_S3_ACCESS_KEY_ID_FILE ?? ''),
    secretAccessKey: readSecretFile(env.AUDIT_ANCHOR_S3_SECRET_ACCESS_KEY_FILE ?? ''),
    forcePathStyle: env.AUDIT_ANCHOR_S3_FORCE_PATH_STYLE,
    retentionDays: env.AUDIT_ANCHOR_RETENTION_DAYS,
  };
}
