import { setTimeout as sleep } from 'node:timers/promises';
import { ApplicationError } from '../../application/errors.js';
import { PermanentJobError, QUEUES, type ClaimedJob, type JobHandler, type JobLane, type QueueName } from '../../application/job-queue.js';
import { retryDelaySeconds } from '../../domain/backoff.js';
import type { Logger } from '../logging/logger.js';
import type { PostgresJobStore } from './postgres-queue.js';

export interface JobRunnerOptions {
  readonly lane: JobLane;
  readonly handlers: Partial<Record<QueueName, JobHandler>>;
  readonly workerId: string;
  readonly logger: Logger;
  /** Jobs em execução ao mesmo tempo neste processo. */
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  /** Espera antes de reprocessar um job cuja concessão venceu. */
  readonly reapRetrySeconds?: number;
  /** Retenção de jobs concluídos/descartados, em dias. */
  readonly retentionDays?: number;
}

/** Código seguro para gravar no job e no log: nunca a mensagem do erro (pode conter dados). */
function failureCode(error: unknown): string {
  if (error instanceof PermanentJobError) return error.code;
  if (error instanceof ApplicationError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'JOB_TIMEOUT';
  return 'UNEXPECTED_ERROR';
}

/**
 * Laço de consumo de uma lane (ADR-0030): reserva jobs, executa o handler com timeout,
 * conclui ou reagenda com backoff, devolve à fila os jobs de workers que morreram e aplica a
 * retenção. Um processo por lane; vários processos da mesma lane podem rodar juntos.
 */
export class JobRunner {
  private readonly running = new Set<Promise<void>>();
  private stopping = false;
  private loop: Promise<void> | undefined;
  private lastMaintenance = 0;

  constructor(
    private readonly store: PostgresJobStore,
    private readonly options: JobRunnerOptions,
  ) {
    for (const queue of Object.keys(options.handlers) as QueueName[]) {
      if (QUEUES[queue].lane !== options.lane) throw new Error(`fila ${queue} não pertence à lane ${options.lane}`);
    }
  }

  private get queues(): QueueName[] {
    return Object.keys(this.options.handlers) as QueueName[];
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Para de buscar jobs e espera os que estão em execução terminarem. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    await Promise.allSettled([...this.running]);
  }

  /**
   * Uma rodada: manutenção, reserva e execução até esvaziar o que estiver pronto.
   * Usada pelos testes e pelo laço principal. Devolve quantos jobs executou.
   */
  async drain(maxRounds = 100): Promise<number> {
    let executed = 0;
    await this.maintenance(true);
    for (let round = 0; round < maxRounds; round++) {
      const jobs = await this.store.claim(this.options.lane, this.queues, this.options.concurrency, this.options.workerId);
      if (jobs.length === 0) break;
      await Promise.all(jobs.map((job) => this.execute(job)));
      executed += jobs.length;
    }
    return executed;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.maintenance(false);
        const free = this.options.concurrency - this.running.size;
        const jobs = free > 0 ? await this.store.claim(this.options.lane, this.queues, free, this.options.workerId) : [];
        for (const job of jobs) {
          const task = this.execute(job).finally(() => this.running.delete(task));
          this.running.add(task);
        }
        if (jobs.length === 0 || free <= 0) await sleep(this.options.pollIntervalMs);
      } catch (error) {
        // Banco indisponível etc.: registra e tenta de novo na próxima volta, sem derrubar o processo.
        this.options.logger.error({ code: failureCode(error), lane: this.options.lane }, 'falha no laço da fila');
        await sleep(this.options.pollIntervalMs * 5);
      }
    }
  }

  private async maintenance(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastMaintenance < 30_000) return;
    this.lastMaintenance = now;
    const reaped = await this.store.reapExpired(this.options.lane, this.options.reapRetrySeconds ?? 30);
    if (reaped > 0) this.options.logger.warn({ lane: this.options.lane, reaped }, 'jobs com concessão vencida devolvidos à fila');
    await this.store.purgeFinished(this.options.lane, this.options.retentionDays ?? 7);
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const definition = QUEUES[job.queue];
    const handler = this.options.handlers[job.queue];
    const log = this.options.logger.child({ jobId: job.id, queue: job.queue, attempt: job.attempt, correlationId: job.correlationId });
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, definition.timeoutSeconds * 1000);
    try {
      if (handler === undefined) throw new PermanentJobError('JOB_HANDLER_MISSING');
      // O timeout vale mesmo para handler que ignore o sinal: o job é dado como falho e a
      // concessão protege contra execução dupla até vencer.
      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => { reject(Object.assign(new Error('timeout'), { name: 'AbortError' })); }, { once: true });
      });
      await Promise.race([handler(job, controller.signal), timedOut]);
      await this.store.complete(job.id, this.options.workerId);
      log.info('job concluído');
    } catch (error) {
      const code = failureCode(error);
      const permanent = error instanceof PermanentJobError;
      const state = await this.store.fail(job.id, this.options.workerId, {
        code,
        permanent,
        retryInSeconds: retryDelaySeconds(job.attempt, definition.backoff),
      });
      const fields = { code, state };
      if (state === 'dead') log.error(fields, 'job enviado à fila de mortos');
      else log.warn(fields, 'job falhou e foi reagendado');
    } finally {
      clearTimeout(timer);
    }
  }
}
