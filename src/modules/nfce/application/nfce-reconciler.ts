import type { AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError } from '../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { afterLookup, DEFAULT_RECONCILIATION_POLICY, nextStep, type LookupResult, type ReconciliationPolicy } from '../../../shared/domain/reconciliation.js';
import { recordStatus, scheduleLookup, type NfeProcBuilder } from './nfce-processor.js';
import type { NfceAuthorizerGateway, NfceCredentialAccess, NfceLookup, NfceWorkerRepositories } from './ports.js';

export type NfceReconcileResult =
  | { readonly kind: 'SKIPPED'; readonly reason: 'NOT_FOUND' | 'NOT_UNKNOWN' | 'NO_ATTEMPT' }
  | { readonly kind: 'WAITING'; readonly until: Date }
  | { readonly kind: 'AUTHORIZED' }
  | { readonly kind: 'DENIED' }
  | { readonly kind: 'NEW_ATTEMPT_SCHEDULED' }
  | { readonly kind: 'CONSULT_AGAIN'; readonly at: Date; readonly lookup: NfceLookup['kind'] };

/**
 * Reconciliação de NFC-e em UNKNOWN (ADR-0072, ADR-0064), com a regra da NFS-e (shared/domain).
 * Cada execução faz no máximo UMA consulta, pela chave e pelo digest da ÚLTIMA tentativa.
 *
 * - Autorizada ou denegada → grava o resultado, sem reenviar.
 * - Só depois da 2ª resposta "não consta" espaçada a nota volta a PENDING; a tentativa seguinte monta
 *   um XML novo (dhEmi novo, regra B09-40), com o mesmo número e o mesmo cNF.
 * - Erro de consulta → backoff, para sempre. Nenhum caminho leva UNKNOWN a FAILED.
 */
export class NfceReconciler {
  constructor(
    private readonly uow: UnitOfWork<NfceWorkerRepositories>,
    private readonly credentials: NfceCredentialAccess,
    private readonly gateway: NfceAuthorizerGateway,
    private readonly nfeProc: NfeProcBuilder,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
  ) {}

  async reconcile(companyId: string, invoiceId: string, context: AuditContext): Promise<NfceReconcileResult> {
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

    const state = { sendingAt: attempt.sendingAt ?? attempt.preparedAt, firstNotFoundAt: attempt.firstNotFoundAt, consecutiveLookupErrors: attempt.consecutiveLookupErrors };
    const step = attempt.outcome === 'ALREADY_EXISTS' ? ({ kind: 'LOOKUP' } as const) : nextStep(state, this.now(), this.policy);
    if (step.kind === 'WAIT_UNTIL') {
      await this.uow.inCompany(companyId, (r) => scheduleLookup(r, companyId, invoiceId, attempt.seq, `${String(attempt.lookups)}:w${String(step.at.getTime())}`, step.at, context));
      return { kind: 'WAITING', until: step.at };
    }

    let lookup: NfceLookup;
    try {
      lookup = await this.credentials.withCredential(companyId, invoice.establishmentId, (credential) =>
        this.gateway.lookup({ accessKey: attempt.accessKey, digestValue: attempt.digestValue }, { environment: invoice.environment, credential }),
      );
    } catch (error) {
      lookup = { kind: 'ERROR', errorCode: error instanceof BusinessRuleError ? error.code : 'LOOKUP_EXCEPTION' };
    }

    const at = this.now();
    const result: LookupResult = lookup.kind === 'AUTHORIZED' || lookup.kind === 'DENIED' ? { kind: 'FOUND' } : lookup.kind === 'NOT_FOUND' ? { kind: 'NOT_FOUND' } : { kind: 'ERROR' };
    const decision = afterLookup(state, result, at, this.policy);

    return this.uow.inCompany(companyId, async (r): Promise<NfceReconcileResult> => {
      switch (decision.kind) {
        case 'AUTHORIZED': {
          await r.attempts.recordLookup(attempt.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          if (lookup.kind === 'AUTHORIZED') {
            const signedXml = await r.attempts.signedXml(attempt.id);
            if (signedXml === undefined) throw new Error('tentativa sem XML assinado');
            const changed = await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'AUTHORIZED', {
              settled: {
                accessKey: attempt.accessKey,
                statusCode: lookup.statusCode,
                protocolNumber: lookup.protocolNumber,
                at: lookup.authorizedAt,
                nfeProcXml: this.nfeProc(signedXml, lookup.protocolXml),
              },
            });
            if (!changed) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
            await recordStatus(r, invoice, 'AUTHORIZED', context, { resolvedBy: 'LOOKUP', statusCode: lookup.statusCode });
            return { kind: 'AUTHORIZED' };
          }
          if (lookup.kind !== 'DENIED') throw new Error('inconsistência na decisão da reconciliação');
          const changed = await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'DENIED', {
            settled: { accessKey: attempt.accessKey, statusCode: lookup.statusCode, protocolNumber: lookup.protocolNumber, at },
          });
          if (!changed) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          await recordStatus(r, invoice, 'DENIED', context, { resolvedBy: 'LOOKUP', statusCode: lookup.statusCode });
          return { kind: 'DENIED' };
        }
        case 'RETRANSMIT': {
          await r.attempts.recordLookup(attempt.id, { firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: 0 });
          if (!(await r.invoices.changeStatus(invoice.id, 'UNKNOWN', 'PENDING'))) return { kind: 'SKIPPED', reason: 'NOT_UNKNOWN' };
          await r.audit.record(context, {
            action: 'consumer_invoice.new_attempt_scheduled',
            subject: { type: 'consumer_invoice', id: invoice.id },
            details: { afterAttempt: attempt.seq, accessKey: attempt.accessKey },
          });
          await r.jobs.enqueue({ queue: 'nfce.process', payload: { companyId, invoiceId: invoice.id }, singletonKey: `${invoice.id}:retry:${String(attempt.seq)}`, correlationId: context.correlationId });
          return { kind: 'NEW_ATTEMPT_SCHEDULED' };
        }
        case 'CONSULT_AGAIN_AT':
          await r.attempts.recordLookup(attempt.id, decision.state);
          await scheduleLookup(r, companyId, invoiceId, attempt.seq, attempt.lookups + 1, decision.at, context);
          return { kind: 'CONSULT_AGAIN', at: decision.at, lookup: lookup.kind };
      }
    });
  }
}
