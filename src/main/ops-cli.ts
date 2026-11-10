import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { AuditContext } from '../shared/application/audit.js';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { composeQueueAdmin } from './compose.js';

/**
 * Operação das filas pelo operador (docs/architecture/07 §8, runbook filas-e-webhooks.md).
 * Papel fiscal_admin; toda alteração entra na cadeia de auditoria da plataforma.
 *
 *   npm run ops -- queues
 *   npm run ops -- pause <fila> --reason "<motivo>"
 *   npm run ops -- resume <fila>
 *   npm run ops -- dead [--limit 50]
 *   npm run ops -- retry <jobId>
 *   npm run ops -- discard <jobId> --reason "<justificativa>"
 *
 * Saída: só nomes de fila, ids, contagens e códigos de erro. Nunca conteúdo de job.
 */
const EnvSchema = z.object({ ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://') });

const USAGE = 'uso: ops queues | pause <fila> --reason <motivo> | resume <fila> | dead [--limit n] | retry <jobId> | discard <jobId> --reason <motivo> [--operator <nome>]\n';

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { reason: { type: 'string' }, limit: { type: 'string' }, operator: { type: 'string' } },
    strict: true,
  });
  const [command, target] = positionals;
  if (command === undefined) throw new UsageError('informe o comando');
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const operator = values.operator ?? userInfo().username;
  const context = { actor: { kind: 'OPERATOR', operator }, correlationId: null } as const satisfies AuditContext;
  const requireTarget = (): string => {
    if (target === undefined || target === '') throw new UsageError(`informe o alvo de "${command}"`);
    return target;
  };

  const database = createDatabase({ url: env.data.ADMIN_DATABASE_URL, poolMax: 1, statementTimeoutMs: 30_000, applicationName: 'orbita-nfe-ops-cli' });
  try {
    const admin = composeQueueAdmin({ db: database.db });
    switch (command) {
      case 'queues': {
        for (const q of await admin.overview()) {
          process.stdout.write(
            `${q.queue.padEnd(24)} lane=${q.lane.padEnd(7)} ${q.paused ? 'PAUSADA ' : 'ativa   '} pendentes=${q.queued} em-execucao=${q.active} mortos=${q.dead}` +
              `${q.oldestQueuedSeconds === null ? '' : ` mais-antigo=${q.oldestQueuedSeconds}s`}\n`,
          );
        }
        return;
      }
      case 'pause':
        await admin.setPaused(requireTarget(), true, values.reason ?? null, context);
        process.stdout.write('fila pausada\n');
        return;
      case 'resume':
        await admin.setPaused(requireTarget(), false, values.reason ?? null, context);
        process.stdout.write('fila retomada\n');
        return;
      case 'dead': {
        const limit = Number(values.limit ?? '50');
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit deve ser de 1 a 500');
        const dead = await admin.listDead(limit);
        process.stdout.write(dead.length === 0 ? 'nenhum job morto\n' : `${dead.map((j) => `${j.id} ${j.queue} tentativas=${j.attempts} erro=${j.lastError ?? '-'}`).join('\n')}\n`);
        return;
      }
      case 'retry':
        await admin.retry(requireTarget(), context);
        process.stdout.write('job devolvido à fila\n');
        return;
      case 'discard':
        await admin.discard(requireTarget(), values.reason ?? '', context);
        process.stdout.write('job descartado\n');
        return;
      default:
        throw new UsageError(`comando desconhecido: ${command}`);
    }
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
    const code = error instanceof ApplicationError ? error.code : error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED';
    process.stderr.write(`falha (${code})\n`);
  }
  process.exit(1);
});
