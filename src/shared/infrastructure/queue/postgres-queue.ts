import { sql } from 'drizzle-orm';
import { InternalError } from '../../application/errors.js';
import {
  QUEUES,
  isQueueName,
  type ClaimedJob,
  type JobLane,
  type JobPayload,
  type JobRequest,
  type JobScheduler,
  type QueueName,
} from '../../application/job-queue.js';
import type { IdGenerator } from '../../application/unit-of-work.js';
import type { Database, Transaction } from '../database/database.js';

type Executor = Pick<Transaction, 'execute'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYLOAD_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const MAX_PAYLOAD_KEYS = 8;

/**
 * O job carrega só identificadores (docs/architecture/07 §3): chaves curtas e valores UUID.
 * Qualquer outra coisa é erro de programação e nunca chega ao banco.
 */
export function assertIdsOnlyPayload(payload: JobPayload): void {
  const entries = Object.entries(payload);
  const valid = entries.length <= MAX_PAYLOAD_KEYS && entries.every(([key, value]) => PAYLOAD_KEY.test(key) && UUID.test(value));
  if (!valid) throw new InternalError('JOB_PAYLOAD_NOT_IDS_ONLY');
}

/**
 * Enfileira na transação corrente (`tx`): o job só existe se a transação confirmar.
 *
 * `ownLane`: a lane que o processo consome. Só nela a repetição da mesma chave singleton é
 * absorvida (`ON CONFLICT DO NOTHING`): o PostgreSQL exige que a linha nova passe na política de
 * LEITURA quando há ON CONFLICT, e cada papel só lê a própria lane (a API não lê nenhuma). Fora
 * dela a chave é sempre nova (id recém-gerado); repeti-la é erro de programação e falha alto.
 */
export function transactionalJobScheduler(tx: Executor, newId: IdGenerator, ownLane?: JobLane): JobScheduler {
  return {
    async enqueue(job: JobRequest): Promise<void> {
      const definition = QUEUES[job.queue];
      assertIdsOnlyPayload(job.payload);
      const runAt = job.runAt ?? null;
      const insert = sql`
        insert into jobs (id, queue, lane, payload, singleton_key, priority, run_at, max_attempts, correlation_id)
        values (${newId()}, ${job.queue}, ${definition.lane}, ${JSON.stringify(job.payload)}::jsonb, ${job.singletonKey ?? null},
                ${definition.priority}, coalesce(${runAt}::timestamptz, now()), ${definition.maxAttempts}, ${job.correlationId ?? null})`;
      const dedupe = definition.lane === ownLane && job.singletonKey !== undefined;
      await tx.execute(
        dedupe ? sql`${insert} on conflict (queue, singleton_key) where singleton_key is not null and state in ('queued', 'active') do nothing` : insert,
      );
    },
  };
}

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  queue: string;
  payload: Record<string, string>;
  attempts: number;
  correlation_id: string | null;
}

/** Margem da concessão além do timeout do handler, para o reaper não roubar job ainda vivo. */
const LEASE_MARGIN_SECONDS = 30;

/**
 * Operações do consumidor (worker). Roda SEM empresa no contexto: o RLS da tabela de jobs
 * restringe cada papel à sua lane; o handler abre a transação da empresa para os dados.
 */
export class PostgresJobStore {
  constructor(private readonly db: Database) {}

  /** Reserva até `limit` jobs prontos (SKIP LOCKED: dois workers nunca pegam o mesmo). */
  async claim(lane: JobLane, queues: readonly QueueName[], limit: number, workerId: string): Promise<ClaimedJob[]> {
    if (queues.length === 0 || limit <= 0) return [];
    const leaseSeconds = Math.max(...queues.map((q) => QUEUES[q].timeoutSeconds)) + LEASE_MARGIN_SECONDS;
    const queueList = sql.join(
      queues.map((q) => sql`${q}`),
      sql`, `,
    );
    const result = await this.db.execute<ClaimedRow>(sql`
      with next as (
        select id from jobs
         where lane = ${lane} and state = 'queued' and run_at <= now()
           and queue in (${queueList})
           and queue not in (select queue from queue_controls where paused)
         order by priority desc, run_at, id
         limit ${limit}
         for update skip locked
      )
      update jobs j
         set state = 'active', attempts = j.attempts + 1, locked_by = ${workerId},
             lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
        from next
       where j.id = next.id
      returning j.id, j.queue, j.payload, j.attempts, j.correlation_id`);
    return result.rows.map((row) => {
      if (!isQueueName(row.queue)) throw new InternalError('JOB_UNKNOWN_QUEUE');
      return { id: row.id, queue: row.queue, payload: row.payload, attempt: row.attempts, correlationId: row.correlation_id };
    });
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    await this.db.execute(sql`
      update jobs set state = 'completed', locked_by = null, lease_until = null, last_error = null, finished_at = now(), updated_at = now()
       where id = ${jobId} and state = 'active' and locked_by = ${workerId}`);
  }

  /**
   * Registra a falha. Esgotadas as tentativas (ou falha permanente), o job vai para `dead`
   * e fica para análise do operador; senão volta para a fila após `retryInSeconds`.
   */
  async fail(jobId: string, workerId: string, failure: { code: string; permanent: boolean; retryInSeconds: number }): Promise<'queued' | 'dead'> {
    const result = await this.db.execute<{ state: 'queued' | 'dead' } & Record<string, unknown>>(sql`
      update jobs
         set state = case when ${failure.permanent} or attempts >= max_attempts then 'dead' else 'queued' end,
             run_at = now() + make_interval(secs => ${failure.retryInSeconds}),
             finished_at = case when ${failure.permanent} or attempts >= max_attempts then now() else null end,
             locked_by = null, lease_until = null, last_error = ${failure.code.slice(0, 200)}, updated_at = now()
       where id = ${jobId} and state = 'active' and locked_by = ${workerId}
      returning state`);
    return result.rows[0]?.state ?? 'queued';
  }

  /**
   * Jobs ativos com concessão vencida (worker morreu ou travou): contam como tentativa falha.
   * O handler é idempotente, então rodar de novo é seguro; quem transmite a terceiros usa o
   * protocolo de write-ahead (ADR-0022) para nunca reenviar às cegas.
   */
  async reapExpired(lane: JobLane, retryInSeconds: number): Promise<number> {
    const result = await this.db.execute(sql`
      update jobs
         set state = case when attempts >= max_attempts then 'dead' else 'queued' end,
             finished_at = case when attempts >= max_attempts then now() else null end,
             run_at = now() + make_interval(secs => ${retryInSeconds}),
             locked_by = null, lease_until = null, last_error = 'LEASE_EXPIRED', updated_at = now()
       where lane = ${lane} and state = 'active' and lease_until < now()`);
    return result.rowCount ?? 0;
  }

  /** Remove jobs concluídos ou descartados há mais de `olderThanDays` (retenção). */
  async purgeFinished(lane: JobLane, olderThanDays: number): Promise<number> {
    const result = await this.db.execute(sql`
      delete from jobs
       where lane = ${lane} and state in ('completed', 'discarded') and finished_at < now() - make_interval(days => ${olderThanDays})`);
    return result.rowCount ?? 0;
  }
}
