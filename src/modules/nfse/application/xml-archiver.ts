import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import { InternalError } from '../../../shared/application/errors.js';
import { PermanentJobError, type JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import type { NfseArtifactStore, NfseWorkerRepositories } from './ports.js';

const DAY_MS = 86_400_000;

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

/** Chave do objeto (ADR-0010): `company/{empresa}/nfse/{aaaa}/{mm}/{nota}/nfse-{sha256}.xml`, mês da autorização em UTC. */
export function archiveKey(companyId: string, invoiceId: string, authorizedAt: Date, sha256: string): string {
  const yyyy = String(authorizedAt.getUTCFullYear());
  const mm = String(authorizedAt.getUTCMonth() + 1).padStart(2, '0');
  return `company/${companyId}/nfse/${yyyy}/${mm}/${invoiceId}/nfse-${sha256}.xml`;
}

export type ArchiveResult = { readonly kind: 'ARCHIVED'; readonly objectKey: string } | { readonly kind: 'ALREADY_ARCHIVED' };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Arquiva o XML autorizado da NFS-e no bucket com Object Lock (ADR-0010, ADR-0048).
 *
 * - Confere os bytes contra o SHA-256 gravado junto com a autorização ANTES de enviar.
 * - Grava fora da transação (rede) e relê do bucket: só marca arquivado se a releitura bater.
 * - Repetir é seguro: a chave tem o hash, e a nota já arquivada não é enviada de novo.
 * - O XML continua no banco; o bucket é a cópia imutável fora da VPS.
 */
export class AuthorizedXmlArchiver {
  constructor(
    private readonly uow: UnitOfWork<NfseWorkerRepositories>,
    private readonly store: NfseArtifactStore,
    /** Retenção COMPLIANCE contada da autorização. Prazo legal de guarda: decisão do responsável (ADR-0048). */
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retenção do arquivamento inválida');
  }

  async archive(companyId: string, invoiceId: string, context: AuditContext): Promise<ArchiveResult> {
    const stored = await this.uow.inCompany(companyId, (r) => r.invoices.authorizedXml(invoiceId));
    if (stored === undefined) throw new PermanentJobError('SERVICE_INVOICE_NOT_FOUND');
    if (stored.objectKey !== null) return { kind: 'ALREADY_ARCHIVED' };
    if (stored.xml === null || stored.authorizedAt === null) throw new PermanentJobError('NFSE_XML_MISSING');
    if (stored.sha256 === null) throw new PermanentJobError('NFSE_XML_HASH_MISSING');

    const body = Buffer.from(stored.xml, 'utf8');
    // O XML do banco tem de ser o que foi gravado na autorização: senão, nada vai para o bucket.
    if (sha256(body) !== stored.sha256) throw new PermanentJobError('NFSE_XML_HASH_MISMATCH');

    const retainUntil = new Date(stored.authorizedAt.getTime() + this.retentionDays * DAY_MS);
    if (retainUntil.getTime() <= this.now().getTime()) throw new PermanentJobError('NFSE_ARCHIVE_RETENTION_EXPIRED');
    const objectKey = archiveKey(companyId, invoiceId, stored.authorizedAt, stored.sha256);

    const readBack = await this.store.put({ key: objectKey, body, contentType: 'application/xml', retainUntil });
    if (sha256(readBack) !== stored.sha256) throw new InternalError('NFSE_ARCHIVE_READBACK_MISMATCH');

    return this.uow.inCompany(companyId, async (r): Promise<ArchiveResult> => {
      if (!(await r.invoices.markArchived(invoiceId, { objectKey, archivedAt: this.now(), retainUntil }))) return { kind: 'ALREADY_ARCHIVED' };
      await r.audit.record(context, {
        action: 'service_invoice.xml_archived',
        subject: { type: 'service_invoice', id: invoiceId },
        details: { objectKey, sha256: stored.sha256, retainUntil: retainUntil.toISOString() },
      });
      return { kind: 'ARCHIVED', objectKey };
    });
  }
}
