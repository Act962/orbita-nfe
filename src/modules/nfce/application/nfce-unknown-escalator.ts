import type { AuditContext } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import {
  DEFAULT_ESCALATION_POLICY,
  escalationJobKey,
  escalationLevel,
  nextEscalationAt,
  type EscalationLevel,
  type EscalationPolicy,
} from '../../../shared/domain/unknown-escalation.js';
import type { NfceUnknownAlertSink, NfceWorkerRepositories } from './ports.js';

export type NfceEscalationResult =
  | { readonly kind: 'STOPPED'; readonly reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'NO_ATTEMPT' }
  | { readonly kind: 'ALERTED'; readonly level: EscalationLevel; readonly next: Date }
  | { readonly kind: 'NOT_YET'; readonly next: Date };

/**
 * Agenda a primeira verificação quando a NFC-e entra em UNKNOWN, na mesma transação. A idade conta
 * do envio da tentativa (`since`).
 */
export async function scheduleNfceEscalation(
  jobs: JobScheduler,
  input: { readonly companyId: string; readonly invoiceId: string; readonly attemptSeq: number; readonly since: Date; readonly correlationId: string | null },
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): Promise<void> {
  const at = nextEscalationAt(input.since, input.since, policy);
  await jobs.enqueue({
    queue: 'nfce.escalate',
    payload: { companyId: input.companyId, invoiceId: input.invoiceId },
    singletonKey: escalationJobKey(input.invoiceId, input.attemptSeq, at),
    runAt: at,
    correlationId: input.correlationId,
  });
}

/**
 * Alertas de NFC-e em UNKNOWN pela idade (ADR-0079, molde do ADR-0034 item 5 e do doc 12 §6). Cada
 * execução avalia a idade, alerta (log estruturado, só identificadores) e agenda a próxima
 * verificação. Para sozinho quando a nota sai de UNKNOWN. Se uma tentativa nova também ficar
 * incerta, a cadeia antiga passa a contar da nova e converge com a dela (mesma chave do job). Não
 * muda a nota nem consulta o autorizador: isso continua com o reconciliador.
 */
export class NfceUnknownEscalator {
  constructor(
    private readonly uow: UnitOfWork<NfceWorkerRepositories>,
    private readonly alerts: NfceUnknownAlertSink,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
  ) {}

  escalate(companyId: string, invoiceId: string, context: AuditContext): Promise<NfceEscalationResult> {
    return this.uow.inCompany(companyId, async (r): Promise<NfceEscalationResult> => {
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
        queue: 'nfce.escalate',
        payload: { companyId, invoiceId },
        singletonKey: escalationJobKey(invoiceId, attempt.seq, next),
        runAt: next,
        correlationId: context.correlationId,
      });
      if (level === undefined) return { kind: 'NOT_YET', next };
      this.alerts.raise({
        level,
        companyId,
        consumerInvoiceId: invoiceId,
        environment: invoice.environment,
        ageSeconds: Math.floor((at.getTime() - since.getTime()) / 1000),
        attemptSeq: attempt.seq,
        lookups: attempt.lookups,
      });
      return { kind: 'ALERTED', level, next };
    });
  }
}
