import { hostname } from 'node:os';
import type { JobHandler, JobLane, QueueName } from '../shared/application/job-queue.js';
import type { DatabaseHandle } from '../shared/infrastructure/database/database.js';
import type { Logger } from '../shared/infrastructure/logging/logger.js';
import { JobRunner } from '../shared/infrastructure/queue/job-runner.js';
import { PostgresJobStore } from '../shared/infrastructure/queue/postgres-queue.js';
import { uuidv7 } from '../shared/infrastructure/ids.js';

/** Sobe o laço da fila da lane e encerra com graça em SIGTERM/SIGINT (espera os jobs em curso). */
export function runWorker(options: {
  lane: JobLane;
  database: DatabaseHandle;
  handlers: Partial<Record<QueueName, JobHandler>>;
  logger: Logger;
  concurrency: number;
  pollIntervalMs: number;
  retentionDays: number;
  onClose?: () => Promise<void>;
}): void {
  const workerId = `${options.lane}@${hostname()}#${process.pid}:${uuidv7().slice(-8)}`;
  const runner = new JobRunner(new PostgresJobStore(options.database.db), {
    lane: options.lane,
    handlers: options.handlers,
    workerId,
    logger: options.logger,
    concurrency: options.concurrency,
    pollIntervalMs: options.pollIntervalMs,
    retentionDays: options.retentionDays,
  });

  const shutdown = (signal: string): void => {
    options.logger.info({ signal }, 'encerrando: aguardando jobs em execução');
    runner
      .stop()
      .then(() => options.onClose?.())
      .then(() => options.database.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          options.logger.error({ err: error }, 'falha ao encerrar');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  runner.start();
  options.logger.info({ workerId, queues: Object.keys(options.handlers) }, 'worker iniciado');
}
