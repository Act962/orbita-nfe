import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadPrivateKek, X509TrustStore } from '../modules/certificates/public.js';
import type { AuditContext } from '../shared/application/audit.js';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { composeFiscalWorker } from './compose.js';

/**
 * Validação de certificados pendentes, no papel do worker-fiscal (ADR-0009, ADR-0021).
 *
 * Provisório: a partir da semana 6 da Fase 1 a validação é disparada pela fila (outbox) logo
 * após o upload. Esta CLI roda com as MESMAS credenciais do worker-fiscal (WORKER_DATABASE_URL +
 * KEK privada) e nunca deve ser instalada no container da API.
 *
 *   npm run certificates -- validate --company <uuid> [--certificate <uuid>]
 *
 * Saída: só ids, status e motivos. Nenhum dado do certificado.
 */
const EnvSchema = z.object({
  WORKER_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://'),
  WORKER_CERTIFICATE_KEK_PRIVATE_FILE: z.string().min(1),
  CERTIFICATE_TRUST_BUNDLE_FILE: z.string().min(1),
});

const USAGE = 'uso: certificates validate --company <uuid> [--certificate <uuid>]\n';
const CONTEXT: AuditContext = { actor: { kind: 'SYSTEM', process: 'certificates-cli' }, correlationId: null };

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { company: { type: 'string' }, certificate: { type: 'string' } }, strict: true });
  if (command !== 'validate') throw new UsageError(command === undefined ? 'informe o comando' : `comando desconhecido: ${command}`);
  const company = values.company;
  if (company === undefined || company === '') throw new UsageError('--company é obrigatório');

  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  const database = createDatabase({ url: env.data.WORKER_DATABASE_URL, poolMax: 1, statementTimeoutMs: 30_000, applicationName: 'orbita-nfe-certificates-cli' });
  try {
    const { vault } = composeFiscalWorker({
      db: database.db,
      certificateKeks: [loadPrivateKek(env.data.WORKER_CERTIFICATE_KEK_PRIVATE_FILE)],
      trustStore: X509TrustStore.fromFile(env.data.CERTIFICATE_TRUST_BUNDLE_FILE),
    });
    if (values.certificate !== undefined) {
      const outcome = await vault.validate(company, values.certificate, CONTEXT);
      process.stdout.write(`${values.certificate}: ${JSON.stringify(outcome)}\n`);
      return;
    }
    const outcomes = await vault.validatePending(company, CONTEXT);
    process.stdout.write(outcomes.length === 0 ? 'nenhum certificado pendente\n' : `${outcomes.map((o) => JSON.stringify(o)).join('\n')}\n`);
  } finally {
    await database.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
  } else if (error instanceof ApplicationError && error.category !== 'INTERNAL') {
    process.stderr.write(`erro ${error.code}: ${error.message}\n`);
  } else {
    // Nunca a mensagem bruta: pode conter dados do banco ou do material criptográfico.
    const code = error instanceof ApplicationError ? error.code : error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED';
    process.stderr.write(`falha (${code})\n`);
  }
  process.exit(1);
});
