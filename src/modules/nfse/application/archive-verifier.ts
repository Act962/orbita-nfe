import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { nextDailyRun, runDay } from '../../../shared/domain/daily-schedule.js';
import type { ArchivedXmlDue, ArchivedXmlKind, NfseArtifactStore, NfseWorkerRepositories } from './ports.js';

const DAY_MS = 86_400_000;

/** Cada objeto é conferido de novo depois de 30 dias da última conferência boa (ADR-0051). */
export const REVERIFY_AFTER_DAYS = 30;
/** Objeto com falha é conferido (e alertado) de novo uma vez por dia, até voltar a bater. */
export const RECHECK_FAILED_AFTER_DAYS = 1;
/** Objetos por execução; lote cheio agenda a continuação logo em seguida. */
export const VERIFY_BATCH = 200;
export const VERIFY_CONTINUE_AFTER_MS = 60_000;

/** Códigos estáveis da falha. Nada do conteúdo do XML (tem dados pessoais do tomador). */
export type ArchiveCheckFailure =
  /** O XML do banco não bate com o hash gravado junto com ele. */
  | 'DB_XML_HASH_MISMATCH'
  /** O objeto não está no bucket. */
  | 'ARCHIVE_OBJECT_MISSING'
  /** O objeto existe, mas os bytes não batem com o hash. */
  | 'ARCHIVE_OBJECT_HASH_MISMATCH'
  /** O objeto não está travado em COMPLIANCE até a retenção gravada. */
  | 'ARCHIVE_OBJECT_NOT_LOCKED';

/** Destino do alerta (log estruturado no worker-fiscal; só identificadores). */
export interface ArchiveIntegrityAlertSink {
  raise(alert: { readonly companyId: string; readonly kind: ArchivedXmlKind; readonly documentId: string; readonly invoiceId: string; readonly failureCode: ArchiveCheckFailure }): void;
}

export interface VerifyOutcome {
  readonly checked: number;
  readonly failed: number;
  /** Lote cheio: pode haver mais objetos na vez. */
  readonly more: boolean;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Agenda a próxima conferência diária da empresa (no máximo um job por dia, pela chave). */
export async function scheduleArchiveVerification(jobs: JobScheduler, companyId: string, now: Date, correlationId: string | null): Promise<void> {
  const next = nextDailyRun(now);
  await jobs.enqueue({ queue: 'nfse.verify-archives', payload: { companyId }, singletonKey: `${companyId}:${runDay(next)}`, runAt: next, correlationId });
}

/**
 * Conferência periódica dos XML arquivados no bucket com Object Lock (ADR-0051): relê cada objeto
 * e confere bytes, trava e retenção contra o que o banco gravou; confere também o XML do banco
 * contra o hash. Falha não para a varredura: vira alerta, auditoria e linha em
 * `archived_xml_checks`, e volta a ser conferida no dia seguinte.
 *
 * Erro de rede ou do bucket NÃO é falha de integridade: sobe, e o job tenta de novo. O que já foi
 * conferido fica gravado.
 */
export class ArchivedXmlVerifier {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly store: NfseArtifactStore,
    private readonly alerts: ArchiveIntegrityAlertSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verifyCompany(companyId: string, context: AuditContext): Promise<VerifyOutcome> {
    const at = this.now();
    const due = await this.uow.inCompany(companyId, (r) =>
      r.archiveChecks.due({
        verifiedBefore: new Date(at.getTime() - REVERIFY_AFTER_DAYS * DAY_MS),
        failedBefore: new Date(at.getTime() - RECHECK_FAILED_AFTER_DAYS * DAY_MS),
        retainedAfter: at,
        limit: VERIFY_BATCH,
      }),
    );
    let failed = 0;
    for (const item of due) {
      const failure = await this.check(item);
      const checkedAt = this.now();
      await this.uow.inCompany(companyId, async (r) => {
        if (failure === undefined) {
          await r.archiveChecks.recordVerified(item.kind, item.documentId, checkedAt);
          return;
        }
        await r.archiveChecks.recordFailed(item.kind, item.documentId, failure, checkedAt);
        await r.audit.record(context, {
          action: 'service_invoice.archived_xml_check_failed',
          subject: { type: 'service_invoice', id: item.invoiceId },
          details: { kind: item.kind, documentId: item.documentId, objectKey: item.objectKey, failureCode: failure },
        });
      });
      if (failure !== undefined) {
        failed += 1;
        this.alerts.raise({ companyId, kind: item.kind, documentId: item.documentId, invoiceId: item.invoiceId, failureCode: failure });
      }
    }
    return { checked: due.length, failed, more: due.length === VERIFY_BATCH };
  }

  private async check(item: ArchivedXmlDue): Promise<ArchiveCheckFailure | undefined> {
    if (sha256(Buffer.from(item.xml, 'utf8')) !== item.sha256) return 'DB_XML_HASH_MISMATCH';
    const stored = await this.store.read(item.objectKey);
    if (stored === undefined) return 'ARCHIVE_OBJECT_MISSING';
    if (sha256(stored.body) !== item.sha256) return 'ARCHIVE_OBJECT_HASH_MISMATCH';
    // Mesma tolerância da releitura do arquivamento (precisão de segundos do provedor).
    if (stored.lockMode !== 'COMPLIANCE' || stored.retainUntil === null || stored.retainUntil.getTime() < item.retainUntil.getTime() - 1000) {
      return 'ARCHIVE_OBJECT_NOT_LOCKED';
    }
    return undefined;
  }
}
