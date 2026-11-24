import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import { InternalError } from '../../../shared/application/errors.js';
import { PermanentJobError, type JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { scheduleArchiveVerification } from './archive-verifier.js';
import type { NfseArtifactStore, NfseWorkerRepositories } from './ports.js';

const DAY_MS = 86_400_000;

/** Código do evento de cancelamento no leiaute (e101101, ADR-0035). */
const CANCELLATION_EVENT = '101101';

/**
 * Enfileira o arquivamento do XML autorizado (ADR-0048), na MESMA transação que grava a
 * autorização: se a nota ficou AUTHORIZED, o job existe.
 */
export async function scheduleArchive(jobs: JobScheduler, input: { companyId: string; invoiceId: string; correlationId: string | null }): Promise<void> {
  await jobs.enqueue({
    queue: 'nfse.archive',
    payload: { companyId: input.companyId, invoiceId: input.invoiceId },
    singletonKey: `${input.invoiceId}:archive`,
    correlationId: input.correlationId,
  });
}

/** O mesmo para o XML do evento de cancelamento (ADR-0049), na transação do REGISTERED. */
export async function scheduleCancellationArchive(jobs: JobScheduler, input: { companyId: string; cancellationId: string; correlationId: string | null }): Promise<void> {
  await jobs.enqueue({
    queue: 'nfse.archive-cancellation',
    payload: { companyId: input.companyId, cancellationId: input.cancellationId },
    singletonKey: `${input.cancellationId}:archive`,
    correlationId: input.correlationId,
  });
}

const month = (at: Date): string => `${String(at.getUTCFullYear())}/${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/** Chave do objeto (ADR-0010): `company/{empresa}/nfse/{aaaa}/{mm}/{nota}/nfse-{sha256}.xml`, mês da autorização em UTC. */
export function archiveKey(companyId: string, invoiceId: string, authorizedAt: Date, sha256: string): string {
  return `company/${companyId}/nfse/${month(authorizedAt)}/${invoiceId}/nfse-${sha256}.xml`;
}

/**
 * Chave do evento (ADR-0049): na pasta da NOTA, com o mês do registro do evento:
 * `company/{empresa}/nfse/{aaaa}/{mm}/{nota}/event-101101-{cancelamento}-{sha256}.xml`.
 */
export function cancellationArchiveKey(companyId: string, invoiceId: string, cancellationId: string, registeredAt: Date, sha256: string): string {
  return `company/${companyId}/nfse/${month(registeredAt)}/${invoiceId}/event-${CANCELLATION_EVENT}-${cancellationId}-${sha256}.xml`;
}

export type ArchiveResult = { readonly kind: 'ARCHIVED'; readonly objectKey: string } | { readonly kind: 'ALREADY_ARCHIVED' };

interface Archivable {
  readonly xml: string | null;
  readonly sha256: string | null;
  /** Autorização da nota ou registro do evento: conta a retenção e dá o mês da chave. */
  readonly at: Date | null;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Arquiva XML fiscal no bucket com Object Lock (ADR-0010, ADR-0048, ADR-0049): o XML autorizado da
 * NFS-e e o XML do evento de cancelamento.
 *
 * - Confere os bytes contra o SHA-256 gravado junto com o XML ANTES de enviar.
 * - Grava fora da transação (rede) e relê do bucket: só marca arquivado se a releitura bater.
 * - Repetir é seguro: a chave tem o hash, e o que já foi arquivado não é enviado de novo.
 * - O XML continua no banco; o bucket é a cópia imutável fora da VPS.
 */
export class AuthorizedXmlArchiver {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly store: NfseArtifactStore,
    /** Retenção COMPLIANCE contada da autorização/registro. Prazo legal de guarda: decisão do responsável (ADR-0048). */
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retenção do arquivamento inválida');
  }

  async archive(companyId: string, invoiceId: string, context: AuditContext): Promise<ArchiveResult> {
    const stored = await this.uow.inCompany(companyId, (r) => r.invoices.authorizedXml(invoiceId));
    if (stored === undefined) throw new PermanentJobError('SERVICE_INVOICE_NOT_FOUND');
    if (stored.objectKey !== null) return { kind: 'ALREADY_ARCHIVED' };
    const { objectKey, retainUntil, hash } = await this.put({ xml: stored.xml, sha256: stored.sha256, at: stored.authorizedAt }, (at, hex) =>
      archiveKey(companyId, invoiceId, at, hex),
    );
    return this.uow.inCompany(companyId, async (r): Promise<ArchiveResult> => {
      if (!(await r.invoices.markArchived(invoiceId, { objectKey, archivedAt: this.now(), retainUntil }))) return { kind: 'ALREADY_ARCHIVED' };
      await r.audit.record(context, {
        action: 'service_invoice.xml_archived',
        subject: { type: 'service_invoice', id: invoiceId },
        details: { objectKey, sha256: hash, retainUntil: retainUntil.toISOString() },
      });
      await scheduleArchiveVerification(r.jobs, companyId, this.now(), context.correlationId);
      return { kind: 'ARCHIVED', objectKey };
    });
  }

  async archiveCancellationEvent(companyId: string, cancellationId: string, context: AuditContext): Promise<ArchiveResult> {
    const stored = await this.uow.inCompany(companyId, (r) => r.cancellations.eventXml(cancellationId));
    if (stored === undefined) throw new PermanentJobError('CANCELLATION_NOT_FOUND');
    if (stored.objectKey !== null) return { kind: 'ALREADY_ARCHIVED' };
    const { objectKey, retainUntil, hash } = await this.put({ xml: stored.xml, sha256: stored.sha256, at: stored.registeredAt }, (at, hex) =>
      cancellationArchiveKey(companyId, stored.invoiceId, cancellationId, at, hex),
    );
    return this.uow.inCompany(companyId, async (r): Promise<ArchiveResult> => {
      if (!(await r.cancellations.markEventArchived(cancellationId, { objectKey, archivedAt: this.now(), retainUntil }))) return { kind: 'ALREADY_ARCHIVED' };
      await r.audit.record(context, {
        action: 'service_invoice.cancellation_xml_archived',
        subject: { type: 'service_invoice', id: stored.invoiceId },
        details: { cancellationId, objectKey, sha256: hash, retainUntil: retainUntil.toISOString() },
      });
      await scheduleArchiveVerification(r.jobs, companyId, this.now(), context.correlationId);
      return { kind: 'ARCHIVED', objectKey };
    });
  }

  /** Confere o hash, grava com retenção, relê e confere de novo. Nada é marcado aqui. */
  private async put(item: Archivable, keyFor: (at: Date, sha256: string) => string): Promise<{ objectKey: string; retainUntil: Date; hash: string }> {
    if (item.xml === null || item.at === null) throw new PermanentJobError('NFSE_XML_MISSING');
    if (item.sha256 === null) throw new PermanentJobError('NFSE_XML_HASH_MISSING');
    const body = Buffer.from(item.xml, 'utf8');
    // O XML do banco tem de ser o que foi gravado junto com o hash: senão, nada vai para o bucket.
    if (sha256(body) !== item.sha256) throw new PermanentJobError('NFSE_XML_HASH_MISMATCH');

    const retainUntil = new Date(item.at.getTime() + this.retentionDays * DAY_MS);
    if (retainUntil.getTime() <= this.now().getTime()) throw new PermanentJobError('NFSE_ARCHIVE_RETENTION_EXPIRED');
    const objectKey = keyFor(item.at, item.sha256);

    const readBack = await this.store.put({ key: objectKey, body, contentType: 'application/xml', retainUntil });
    if (sha256(readBack) !== item.sha256) throw new InternalError('NFSE_ARCHIVE_READBACK_MISMATCH');
    return { objectKey, retainUntil, hash: item.sha256 };
  }
}
