import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { S3ArtifactStoreOptions } from '../modules/nfse/public.js';

/**
 * Bucket dos artefatos fiscais, com Object Lock (ADR-0010, ADR-0048). Só o worker-fiscal grava:
 * é ele que tem o XML autorizado. As credenciais vêm de ARQUIVOS montados, nunca do valor em
 * variável de ambiente.
 *
 * A retenção NÃO tem valor padrão: é o prazo legal de guarda dos documentos fiscais, a definir pelo
 * responsável com o contador (ADR-0048). Bucket configurado sem retenção é erro.
 */
export const artifactEnvShape = {
  ARTIFACTS_S3_ENDPOINT: z.url().optional(),
  ARTIFACTS_S3_REGION: z.string().min(1).default('us-east-1'),
  ARTIFACTS_S3_BUCKET: z.string().min(3).max(63).optional(),
  ARTIFACTS_S3_ACCESS_KEY_ID_FILE: z.string().min(1).optional(),
  ARTIFACTS_S3_SECRET_ACCESS_KEY_FILE: z.string().min(1).optional(),
  ARTIFACTS_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Dias de retenção COMPLIANCE de cada XML, contados da autorização. Sem padrão (prazo legal). */
  ARTIFACTS_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).optional(),
};

type ArtifactEnv = z.infer<z.ZodObject<typeof artifactEnvShape>>;

const REQUIRED = [
  'ARTIFACTS_S3_ENDPOINT',
  'ARTIFACTS_S3_BUCKET',
  'ARTIFACTS_S3_ACCESS_KEY_ID_FILE',
  'ARTIFACTS_S3_SECRET_ACCESS_KEY_FILE',
  'ARTIFACTS_RETENTION_DAYS',
] as const;

/** Configurado = as cinco variáveis obrigatórias presentes. Metade configurado é erro. */
export function artifactConfigState(env: ArtifactEnv): 'configured' | 'absent' | 'partial' {
  const present = REQUIRED.filter((name) => env[name] !== undefined).length;
  if (present === REQUIRED.length) return 'configured';
  return present === 0 ? 'absent' : 'partial';
}

const readSecretFile = (path: string): string => {
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0) throw new Error(`arquivo de credencial vazio: ${path}`);
  return value;
};

export function artifactArchiveOptions(env: ArtifactEnv): { readonly store: S3ArtifactStoreOptions; readonly retentionDays: number } | undefined {
  if (artifactConfigState(env) !== 'configured' || env.ARTIFACTS_RETENTION_DAYS === undefined) return undefined;
  return {
    store: {
      endpoint: env.ARTIFACTS_S3_ENDPOINT ?? '',
      region: env.ARTIFACTS_S3_REGION,
      bucket: env.ARTIFACTS_S3_BUCKET ?? '',
      accessKeyId: readSecretFile(env.ARTIFACTS_S3_ACCESS_KEY_ID_FILE ?? ''),
      secretAccessKey: readSecretFile(env.ARTIFACTS_S3_SECRET_ACCESS_KEY_FILE ?? ''),
      forcePathStyle: env.ARTIFACTS_S3_FORCE_PATH_STYLE,
    },
    retentionDays: env.ARTIFACTS_RETENTION_DAYS,
  };
}
