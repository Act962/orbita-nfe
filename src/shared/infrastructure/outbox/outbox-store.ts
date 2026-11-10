import { sql } from 'drizzle-orm';
import { InternalError } from '../../application/errors.js';
import type { JobScheduler } from '../../application/job-queue.js';
import { isIntegrationEventType, type EventOutbox, type IntegrationEvent } from '../../application/outbox.js';
import type { IdGenerator } from '../../application/unit-of-work.js';
import type { Transaction } from '../database/database.js';
import { isSensitiveKey } from '../logging/sanitize.js';

type Executor = Pick<Transaction, 'execute'>;

/**
 * Outbox da empresa do contexto da transação: grava o evento e enfileira `webhooks.fanout`
 * no mesmo commit. Sem dual write: se a transação falhar, não há evento nem job.
 */
export function companyEventOutbox(tx: Executor, deps: { newId: IdGenerator; jobs: JobScheduler }): EventOutbox {
  return {
    async publish(event: IntegrationEvent): Promise<string> {
      if (!isIntegrationEventType(event.type)) throw new InternalError('OUTBOX_UNKNOWN_EVENT_TYPE');
      if (Object.keys(event.data).some((key) => isSensitiveKey(key))) throw new InternalError('OUTBOX_DATA_REJECTED');
      const id = deps.newId();
      const result = await tx.execute<{ company_id: string } & Record<string, unknown>>(sql`
        insert into outbox_events (id, company_id, type, subject_type, subject_id, data, correlation_id)
        values (${id}, app_current_company(), ${event.type}, ${event.subject.type}, ${event.subject.id},
                ${JSON.stringify(event.data)}::jsonb, ${event.correlationId})
        returning company_id`);
      const companyId = result.rows[0]?.company_id;
      if (companyId === undefined) throw new InternalError('OUTBOX_WITHOUT_COMPANY');
      await deps.jobs.enqueue({ queue: 'webhooks.fanout', payload: { companyId, eventId: id }, singletonKey: id, correlationId: event.correlationId });
      return id;
    },
  };
}
