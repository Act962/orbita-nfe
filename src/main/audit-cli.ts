import { parseArgs } from 'node:util';
import { z } from 'zod';
import { S3AnchorStore, type AuditChainRef } from '../modules/audit/public.js';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { anchorEnvShape, anchorStoreOptions } from './anchor-config.js';
import { composeAuditVerifier } from './compose.js';

/**
 * Verificação das cadeias de auditoria (docs/architecture/14 §A4), papel fiscal_admin.
 *
 *   npm run audit -- verify --company <uuid> [--anchor]
 *   npm run audit -- verify --platform [--anchor]
 *
 * `--anchor` confere também contra a âncora mais recente do bucket com Object Lock (ADR-0031),
 * com a credencial de LEITURA do bucket (variáveis AUDIT_ANCHOR_S3_*).
 *
 * Código de saída: 0 = íntegra; 2 = adulteração detectada (incidente: ver runbook);
 * 3 = `--anchor` pedido e não há âncora para a cadeia.
 */
const EnvSchema = z.object({
  ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://'),
  ...anchorEnvShape,
});
const USAGE = 'uso: audit verify (--company <uuid> | --platform) [--anchor]\n';

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { company: { type: 'string' }, platform: { type: 'boolean' }, anchor: { type: 'boolean' } },
    strict: true,
  });
  if (command !== 'verify') throw new UsageError(command === undefined ? 'informe o comando' : `comando desconhecido: ${command}`);
  if ((values.company === undefined) === (values.platform !== true)) throw new UsageError('informe --company <uuid> ou --platform');

  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const chain: AuditChainRef = values.company === undefined ? { kind: 'PLATFORM' } : { kind: 'COMPANY', companyId: values.company };

  let anchor: { sequence: number; hashHex: string } | undefined;
  if (values.anchor === true) {
    const options = anchorStoreOptions(env.data);
    if (options === undefined) throw new UsageError('--anchor exige AUDIT_ANCHOR_S3_ENDPOINT, _BUCKET, _ACCESS_KEY_ID_FILE e _SECRET_ACCESS_KEY_FILE');
    const store = new S3AnchorStore(options);
    try {
      const latest = await store.latest(chain);
      if (latest === undefined) {
        process.stdout.write('SEM ÂNCORA: nenhuma âncora gravada para esta cadeia\n');
        return 3;
      }
      anchor = latest;
      process.stdout.write(`âncora ${latest.location}: sequência ${latest.sequence} ${latest.hashHex} (${latest.anchoredAt.toISOString()})\n`);
    } finally {
      store.close();
    }
  }

  const database = createDatabase({ url: env.data.ADMIN_DATABASE_URL, poolMax: 1, statementTimeoutMs: 60_000, applicationName: 'orbita-nfe-audit-cli' });
  try {
    const verifier = composeAuditVerifier({ db: database.db });
    const result = await verifier.verify(chain, anchor);
    if (result.ok) {
      const anchored = anchor === undefined ? '' : '; confere com a âncora';
      process.stdout.write(`cadeia íntegra: ${result.entries} registros; cabeça ${result.head?.sequence ?? 0} ${result.head?.hashHex ?? '-'}${anchored}\n`);
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
