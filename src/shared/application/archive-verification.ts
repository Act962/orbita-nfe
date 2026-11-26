import { nextDailyRun, runDay } from '../domain/daily-schedule.js';
import type { JobScheduler } from './job-queue.js';

/**
 * Agenda a próxima conferência diária dos XML arquivados da empresa (ADR-0051), no máximo um job
 * por dia pela chave. Vale para todos os documentos arquivados: NFS-e, eventos e NFC-e (ADR-0075).
 * O nome da fila é o histórico (`nfse.verify-archives`); ela confere os três tipos.
 */
export async function scheduleArchiveVerification(jobs: JobScheduler, companyId: string, now: Date, correlationId: string | null): Promise<void> {
  const next = nextDailyRun(now);
  await jobs.enqueue({ queue: 'nfse.verify-archives', payload: { companyId }, singletonKey: `${companyId}:${runDay(next)}`, runAt: next, correlationId });
}
