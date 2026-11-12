import type { AuditContext } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { DEFAULT_ESCALATION_POLICY, escalationLevel, nextEscalationAt, type EscalationLevel, type EscalationPolicy } from '../domain/unknown-escalation.js';
import type { NfseWorkerRepositories, UnknownAlertSink } from './ports.js';

export type EscalationResult =
  | { readonly kind: 'STOPPED'; readonly reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'NO_ATTEMPT' }
  | { readonly kind: 'ALERTED'; readonly level: EscalationLevel; readonly next: Date }
  | { readonly kind: 'NOT_YET'; readonly next: Date };

/** Chave do job de escalonamento: o horário da verificação, para duas cadeias convergirem. */
export function escalationJobKey(invoiceId: string, attemptSeq: number, at: Date): string {
  return `${invoiceId}:escalate:${attemptSeq}:${at.getTime()}`;
}

/** Agenda a primeira verificação quando o documento entra em UNKNOWN (mesma transação). */
export async function scheduleFirstEscalation(
  jobs: JobScheduler,
  input: { companyId: string; invoiceId: string; attemptSeq: number; since: Date; correlationId: string | null },
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): Promise<void> {
  const at = nextEscalationAt(input.since, input.since, policy);
  await jobs.enqueue({
    queue: 'nfse.escalate',
    payload: { companyId: input.companyId, invoiceId: input.invoiceId },
    singletonKey: escalationJobKey(input.invoiceId, input.attemptSeq, at),
    runAt: at,
    correlationId: input.correlationId,
  });
}

/**
 * Alertas de NFS-e em UNKNOWN pela idade (doc 12 §6, ADR-0034 item 5). Cada execução avalia a
 * idade, alerta (log estruturado, só identificadores) e agenda a próxima verificação. Para
 * sozinho quando o documento sai de UNKNOWN. Não muda o documento.
 */
export class UnknownEscalator {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly alerts: UnknownAlertSink,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
  ) {}

  escalate(companyId: string, invoiceId: string, context: AuditContext): Promise<EscalationResult> {
    return this.uow.inCompany(companyId, async (r): Promise<EscalationResult> => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'STOPPED', reason: 'NOT_FOUND' };
      if (invoice.status !== 'UNKNOWN') return { kind: 'STOPPED', reason: 'NOT_UNKNOWN' };
      const attempt = await r.attempts.last(invoice.id);
      if (attempt === undefined) return { kind: 'STOPPED', reason: 'NO_ATTEMPT' };

      const since = attempt.sendingAt ?? attempt.preparedAt;
      const at = this.now();
      const level = escalationLevel(at.getTime() - since.getTime(), this.policy);
      const next = nextEscalationAt(since, at, this.policy);
      await r.jobs.enqueue({
        queue: 'nfse.escalate',
        payload: { companyId, invoiceId },
        singletonKey: escalationJobKey(invoiceId, attempt.seq, next),
        runAt: next,
        correlationId: context.correlationId,
      });
      if (level === undefined) return { kind: 'NOT_YET', next };
      this.alerts.raise({
        level,
        companyId,
        invoiceId,
        environment: invoice.environment,
        ageSeconds: Math.floor((at.getTime() - since.getTime()) / 1000),
        attemptSeq: attempt.seq,
        lookups: attempt.lookups,
      });
      return { kind: 'ALERTED', level, next };
    });
  }
}
