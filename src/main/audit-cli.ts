import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { composeAuditVerifier } from './compose.js';

/**
 * Verificação das cadeias de auditoria (docs/architecture/14 §A4), papel fiscal_admin.
 *
 *   npm run audit -- verify --company <uuid>
 *   npm run audit -- verify --platform
 *
 * Código de saída 0 = cadeia íntegra; 2 = adulteração detectada (incidente: ver runbook).
 * A cabeça impressa é o valor a ancorar fora do banco (exportação diária, semana 7).
 */
const EnvSchema = z.object({ ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://') });
const USAGE = 'uso: audit verify (--company <uuid> | --platform)\n';

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { company: { type: 'string' }, platform: { type: 'boolean' } }, strict: true });
  if (command !== 'verify') throw new UsageError(command === undefined ? 'informe o comando' : `comando desconhecido: ${command}`);
  if ((values.company === undefined) === (values.platform !== true)) throw new UsageError('informe --company <uuid> ou --platform');

  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  const database = createDatabase({ url: env.data.ADMIN_DATABASE_URL, poolMax: 1, statementTimeoutMs: 60_000, applicationName: 'orbita-nfe-audit-cli' });
  try {
    const verifier = composeAuditVerifier({ db: database.db });
    const result = await verifier.verify(values.company === undefined ? { kind: 'PLATFORM' } : { kind: 'COMPANY', companyId: values.company });
    if (result.ok) {
      process.stdout.write(`cadeia íntegra: ${result.entries} registros; cabeça ${result.head?.sequence ?? 0} ${result.head?.hashHex ?? '-'}\n`);
      return 0;
    }
    process.stdout.write(`ADULTERAÇÃO DETECTADA: ${result.reason} na sequência ${result.sequence}\n`);
    return 2;
  } finally {
    await database.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) process.stderr.write(`${error.message}\n\n${USAGE}`);
    else process.stderr.write(`falha (${error instanceof ApplicationError ? error.code : 'UNEXPECTED'})\n`);
    process.exit(1);
  },
);
