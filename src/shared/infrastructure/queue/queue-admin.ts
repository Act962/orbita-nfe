import { sql } from 'drizzle-orm';
import type { AuditContext, PlatformAuditTrail } from '../../application/audit.js';
import { BusinessRuleError, NotFoundError, ValidationFailedError } from '../../application/errors.js';
import { QUEUES, isQueueName } from '../../application/job-queue.js';
import type { Database, Transaction } from '../database/database.js';

export interface QueueOverview {
  readonly queue: string;
  readonly lane: string;
  readonly paused: boolean;
  readonly queued: number;
  readonly active: number;
  readonly dead: number;
  readonly oldestQueuedSeconds: number | null;
}

export interface DeadJob {
  readonly id: string;
  readonly queue: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

const MIN_REASON = 5;

/**
 * Operação manual das filas pelo operador (papel fiscal_admin, CLI `npm run ops`). Tudo
 * auditado na cadeia da plataforma. Pausar ou descartar NUNCA altera documento: só o job
 * (docs/architecture/07 §8).
 */
export class QueueAdmin {
  constructor(
    private readonly db: Database,
    private readonly auditFor: (tx: Transaction) => PlatformAuditTrail,
  ) {}

  async overview(): Promise<QueueOverview[]> {
    const counts = await this.db.execute<Record<string, unknown> & { queue: string; queued: number; active: number; dead: number; oldest: number | null }>(sql`
      select queue,
             count(*) filter (where state = 'queued')::int as queued,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where state = 'dead')::int as dead,
             extract(epoch from now() - min(run_at) filter (where state = 'queued' and run_at <= now()))::int as oldest
        from jobs group by queue`);
    const paused = await this.db.execute<{ queue: string } & Record<string, unknown>>(sql`select queue from queue_controls where paused`);
    const pausedSet = new Set(paused.rows.map((r) => r.queue));
    const byQueue = new Map(counts.rows.map((r) => [r.queue, r]));
    return Object.entries(QUEUES).map(([queue, definition]) => {
      const row = byQueue.get(queue);
      return {
        queue,
        lane: definition.lane,
        paused: pausedSet.has(queue),
        queued: row?.queued ?? 0,
        active: row?.active ?? 0,
        dead: row?.dead ?? 0,
        oldestQueuedSeconds: row?.oldest ?? null,
      };
    });
  }

  async setPaused(queue: string, paused: boolean, reason: string | null, context: AuditContext & { actor: { kind: 'OPERATOR'; operator: string } }): Promise<void> {
    if (!isQueueName(queue)) throw new NotFoundError('QUEUE_NOT_FOUND', 'Fila inexistente.');
    if (paused && (reason === null || reason.trim().length < MIN_REASON)) {
      throw new ValidationFailedError([{ code: 'REQUIRED', field: 'reason', message: 'Informe o motivo da pausa.' }]);
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into queue_controls (queue, paused, reason, updated_by, updated_at)
        values (${queue}, ${paused}, ${reason}, ${context.actor.operator}, now())
        on conflict (queue) do update set paused = excluded.paused, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()`);
      await this.auditFor(tx).record(context, {
        action: paused ? 'queue.paused' : 'queue.resumed',
        subject: { type: 'queue', id: queue },
        ...(reason === null ? {} : { details: { reason } }),
      });
    });
  }

  async listDead(limit: number): Promise<DeadJob[]> {
    const result = await this.db.execute<Record<string, unknown> & { id: string; queue: string; attempts: number; last_error: string | null; created_at: Date; finished_at: Date | null }>(sql`
      select id, queue, attempts, last_error, created_at, finished_at from jobs where state = 'dead' order by finished_at desc nulls last limit ${limit}`);
    return result.rows.map((r) => ({ id: r.id, queue: r.queue, attempts: r.attempts, lastError: r.last_error, createdAt: new Date(r.created_at), finishedAt: r.finished_at === null ? null : new Date(r.finished_at) }));
  }

  /** Devolve um job morto à fila, com as tentativas zeradas. */
  async retry(jobId: string, context: AuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.execute<{ queue: string } & Record<string, unknown>>(sql`
        update jobs set state = 'queued', attempts = 0, run_at = now(), finished_at = null, last_error = null, updated_at = now()
         where id = ${jobId} and state = 'dead' returning queue`);
      const queue = result.rows[0]?.queue;
      if (queue === undefined) throw new BusinessRuleError('JOB_NOT_DEAD', 'Só jobs na fila de mortos podem ser reprocessados.');
      await this.auditFor(tx).record(context, { action: 'job.retried', subject: { type: 'job', id: jobId }, details: { queue } });
    });
  }

  /** Descarta um job pendente ou morto (nunca o documento). Exige justificativa. */
  async discard(jobId: string, reason: string, context: AuditContext): Promise<void> {
    if (reason.trim().length < MIN_REASON) throw new ValidationFailedError([{ code: 'REQUIRED', field: 'reason', message: 'Informe a justificativa.' }]);
    await this.db.transaction(async (tx) => {
      const result = await tx.execute<{ queue: string } & Record<string, unknown>>(sql`
        update jobs set state = 'discarded', finished_at = now(), updated_at = now()
         where id = ${jobId} and state in ('queued', 'dead') returning queue`);
      const queue = result.rows[0]?.queue;
      if (queue === undefined) throw new BusinessRuleError('JOB_NOT_DISCARDABLE', 'Só jobs pendentes ou mortos podem ser descartados.');
      await this.auditFor(tx).record(context, { action: 'job.discarded', subject: { type: 'job', id: jobId }, details: { queue, reason } });
    });
  }
}
