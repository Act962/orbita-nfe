import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { AuditContext } from '../shared/application/audit.js';
import { ApplicationError } from '../shared/application/errors.js';
import { createDatabase } from '../shared/infrastructure/database/database.js';
import { composeNfseDesk, composeQueueAdmin } from './compose.js';

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
 * NFS-e em UNKNOWN (ADR-0034, doc 12 §6 e §7, runbook nfse-unknown.md):
 *   npm run ops -- nfse-unknown [--company <uuid>] [--older-than <minutos>] [--limit 50]
 *   npm run ops -- nfse-resolve <notaId> --company <uuid> --outcome AUTHORIZED --nfse-xml <arquivo.xml> --reason "<justificativa>"
 *   npm run ops -- nfse-resolve <notaId> --company <uuid> --outcome NOT_ISSUED --evidence <arquivo> --reason "<justificativa>"
 *   npm run ops -- nfse-resolution <pedidoId> --company <uuid>
 *
 * Saída: só nomes de fila, ids, contagens e códigos de erro. Nunca conteúdo de job.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EnvSchema = z.object({ ADMIN_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve ser uma URL postgres://') });

const USAGE =
  'uso: ops queues | pause <fila> --reason <motivo> | resume <fila> | dead [--limit n] | retry <jobId> | discard <jobId> --reason <motivo>\n' +
  '       | nfse-unknown [--company <uuid>] [--older-than <min>] [--limit n] | nfse-resolution <pedidoId> --company <uuid>\n' +
  '       | nfse-resolve <notaId> --company <uuid> --outcome AUTHORIZED --nfse-xml <arquivo> --reason <justificativa>\n' +
  '       | nfse-resolve <notaId> --company <uuid> --outcome NOT_ISSUED --evidence <arquivo> --reason <justificativa>\n' +
  '     [--operator <nome>]\n';

/** Mesmo limite do XML não confiável (5 MiB). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function readLimited(path: string): Buffer {
  if (statSync(path).size > MAX_FILE_BYTES) throw new UsageError(`arquivo maior que ${MAX_FILE_BYTES} bytes: ${path}`);
  return readFileSync(path);
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? '50');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit deve ser de 1 a 500');
  return limit;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      reason: { type: 'string' },
      limit: { type: 'string' },
      operator: { type: 'string' },
      outcome: { type: 'string' },
      'nfse-xml': { type: 'string' },
      evidence: { type: 'string' },
      'older-than': { type: 'string' },
      company: { type: 'string' },
    },
    strict: true,
  });
  const [command, target] = positionals;
  if (command === undefined) throw new UsageError('informe o comando');
  const env = EnvSchema.safeParse(process.env);
  if (!env.success) throw new UsageError(env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const operator = values.operator ?? userInfo().username;
  const context = { actor: { kind: 'OPERATOR', operator }, correlationId: null } as const satisfies AuditContext;
  const requireCompany = (): string => {
    if (values.company === undefined || !UUID.test(values.company)) throw new UsageError(`"${command}" exige --company <uuid> (a empresa da nota)`);
    return values.company;
  };
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
        const dead = await admin.listDead(parseLimit(values.limit));
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
      case 'nfse-unknown': {
        const minutes = Number(values['older-than'] ?? '0');
        if (!Number.isInteger(minutes) || minutes < 0) throw new UsageError('--older-than deve ser um inteiro de minutos');
        const now = Date.now();
        const list = await composeNfseDesk({ db: database.db }).listUnknown(minutes * 60_000, parseLimit(values.limit), values.company === undefined ? undefined : requireCompany());
        process.stdout.write(
          list.length === 0
            ? 'nenhuma NFS-e em UNKNOWN\n'
            : `${list
                .map(
                  (n) =>
                    `${n.id} empresa=${n.companyId} ${n.environment} idade=${Math.floor((now - n.since.getTime()) / 60_000)}min ` +
                    `tentativa=${n.attemptSeq} consultas=${n.lookups} erros-seguidos=${n.consecutiveLookupErrors}${n.openResolutionId === null ? '' : ` pedido-aberto=${n.openResolutionId}`}`,
                )
                .join('\n')}\n`,
        );
        return;
      }
      case 'nfse-resolve': {
        const outcome = values.outcome ?? '';
        const xmlPath = values['nfse-xml'];
        const evidencePath = values.evidence;
        if (outcome === 'AUTHORIZED' && (xmlPath === undefined || evidencePath !== undefined)) throw new UsageError('AUTHORIZED: informe --nfse-xml (o XML é a evidência), sem --evidence');
        if (outcome === 'NOT_ISSUED' && (evidencePath === undefined || xmlPath !== undefined)) throw new UsageError('NOT_ISSUED: informe --evidence, sem --nfse-xml');
        const resolution = await composeNfseDesk({ db: database.db }).request(
          {
            companyId: requireCompany(),
            invoiceId: requireTarget(),
            outcome,
            reason: values.reason ?? '',
            nfseXml: xmlPath === undefined ? null : readLimited(xmlPath).toString('utf8'),
            evidenceSha256: evidencePath === undefined ? null : createHash('sha256').update(readLimited(evidencePath)).digest('hex'),
            operator,
          },
          context,
        );
        process.stdout.write(
          `pedido ${resolution.id} registrado (${resolution.outcome}, evidência sha256=${resolution.evidenceSha256}).\n` +
            `O worker-fiscal confere e aplica; acompanhe com: npm run ops -- nfse-resolution ${resolution.id} --company ${resolution.companyId}\n`,
        );
        return;
      }
      case 'nfse-resolution': {
        const r = await composeNfseDesk({ db: database.db }).status(requireCompany(), requireTarget());
        process.stdout.write(
          `${r.id} nota=${r.invoiceId} ${r.outcome} estado=${r.state}${r.resultCode === null ? '' : ` resultado=${r.resultCode}`} ` +
            `operador=${r.operator} pedido-em=${r.requestedAt.toISOString()}${r.decidedAt === null ? '' : ` decidido-em=${r.decidedAt.toISOString()}`}\n`,
        );
        return;
      }
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
