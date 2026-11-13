import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError } from '../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { afterLookup, DEFAULT_RECONCILIATION_POLICY, nextStep, type LookupResult, type ReconciliationPolicy } from '../domain/reconciliation.js';
import type { CredentialAccess, LookupOutcome, NfseGateway, NfseWorkerRepositories } from './ports.js';
import { channelOf, completeSubstitution, publishStatus } from './submission-processor.js';

export type ReconcileResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'NO_ATTEMPT' }
  | { readonly kind: 'WAITING'; readonly until: Date }
  | { readonly kind: 'AUTHORIZED' }
  | { readonly kind: 'RETRANSMISSION_SCHEDULED' }
  | { readonly kind: 'CONSULT_AGAIN'; readonly at: Date; readonly lookup: LookupOutcome['kind'] };

/**
 * Reconciliação de NFS-e em UNKNOWN (doc 12 §3, ADR-0032 item 6). Cada execução faz no máximo
 * UMA consulta e agenda a próxima como um job novo com `runAt`.
 *
 * - Encontrada → AUTHORIZED (sem retransmitir).
 * - Retransmissão só depois da 2ª resposta "não encontrado" espaçada, e com o MESMO XML.
 * - Erro de consulta → backoff, para sempre. Nenhum caminho leva UNKNOWN a FAILED.
 */
export class Reconciler {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly credentials: CredentialAccess,
    private readonly gateway: NfseGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
  ) {}

  async reconcile(companyId: string, invoiceId: string, context: AuditContext): Promise<ReconcileResult> {
    const loaded = await this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(invoiceId);
      if (invoice === undefined) return { kind: 'SKIPPED', reason: 'NOT_FOUND' } as const;
      if (invoice.status !== 'UNKNOWN') return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' } as const;
      const attempt = await r.attempts.last(invoice.id);
      if (attempt === undefined) return { kind: 'SKIPPED', reason: 'NO_ATTEMPT' } as const;
      return { kind: 'LOADED', invoice, attempt } as const;
    });
    if (loaded.kind !== 'LOADED') return loaded;
    const { invoice, attempt } = loaded;

    const state = {
      sendingAt: attempt.sendingAt ?? attempt.preparedAt,
      firstNotFoundAt: attempt.firstNotFoundAt,
      consecutiveLookupErrors: attempt.consecutiveLookupErrors,
    };
    // Duplicidade (ALREADY_EXISTS): a DPS existe no autorizador; consulta sem a espera mínima.
    const step = attempt.outcome === 'ALREADY_EXISTS' ? ({ kind: 'LOOKUP' } as const) : nextStep(state, this.now(), this.policy);
    if (step.kind === 'WAIT_UNTIL') {
      // Chave própria: o job corrente ainda está ativo com a chave desta consulta.
      await this.uow.inCompany(companyId, (r) => this.schedule(r, companyId, invoiceId, attempt.seq, `${attempt.lookups}:w${step.at.getTime()}`, step.at, context));
      return { kind: 'WAITING', until: step.at };
    }

    let lookup: LookupOutcome;
    try {
      lookup = await this.credentials.withCredential(companyId, invoice.establishmentId, (credential) =>
        this.gateway.findByDpsId(invoice.dpsId, { environment: invoice.environment, channel: channelOf(invoice), credential }),
      );
    } catch (error) {
      // Sem certificado não há consulta (mTLS): conta como erro de consulta e tenta depois.
      lookup = { kind: 'ERROR', errorCode: error instanceof BusinessRuleError ? error.code : 'LOOKUP_EXCEPTION' };
    }

    const at = this.now();
    const result: LookupResult = lookup.kind === 'FOUND' ? { kind: 'FOUND' } : lookup.kind === 'NOT_FOUND' ? { kind: 'NOT_FOUND' } : { kind: 'ERROR' };
    const decision = afterLookup(state, result, at, this.policy);

    return this.uow.inCompany(companyId, async (r): Promise<ReconcileResult> => {
      switch (decision.kind) {
        case 'AUTHORIZED': {
          if (lookup.kind !== 'FOUND') throw new Error('inconsistência na decisão da reconciliação');
          await r.attempts.recordLookup(attempt.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          const changed = await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'AUTHORIZED', {
            authorization: { accessKey: lookup.accessKey, nfseXml: lookup.nfseXml, authorizedAt: at },
          });
          if (!changed) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          await publishStatus(r, invoice, 'AUTHORIZED', context, { resolvedBy: 'LOOKUP' });
          await completeSubstitution(r, invoice, context);
          return { kind: 'AUTHORIZED' };
        }
        case 'RETRANSMIT': {
          await r.attempts.recordLookup(attempt.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          if (!(await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'PENDING'))) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          await r.audit.record(context, {
            action: 'service_invoice.retransmission_scheduled',
            subject: { type: 'service_invoice', id: invoice.id },
            details: { dpsId: invoice.dpsId, afterAttempt: attempt.seq },
          });
          await r.jobs.enqueue({
            queue: 'nfse.process',
            payload: { companyId, invoiceId: invoice.id },
            singletonKey: `${invoice.id}:retransmit:${attempt.seq}`,
            correlationId: context.correlationId,
          });
          return { kind: 'RETRANSMISSION_SCHEDULED' };
        }
        case 'CONSULT_AGAIN_AT':
          await r.attempts.recordLookup(attempt.id, decision.state);
          await this.schedule(r, companyId, invoiceId, attempt.seq, attempt.lookups + 1, decision.at, context);
          return { kind: 'CONSULT_AGAIN', at: decision.at, lookup: lookup.kind };
      }
    });
  }

  private async schedule(r: NfseWorkerRepositories, companyId: string, invoiceId: string, seq: number, lookup: number | string, runAt: Date, context: AuditContext): Promise<void> {
    await r.jobs.enqueue({
      queue: 'nfse.reconcile',
      payload: { companyId, invoiceId },
      singletonKey: `${invoiceId}:lookup:${seq}:${lookup}`,
      runAt,
      correlationId: context.correlationId,
    });
  }
}
