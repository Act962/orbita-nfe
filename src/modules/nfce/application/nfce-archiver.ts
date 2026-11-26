import { createHash } from 'node:crypto';
import type { AuditContext } from '../../../shared/application/audit.js';
import { InternalError } from '../../../shared/application/errors.js';
import { PermanentJobError, type JobScheduler } from '../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../shared/application/unit-of-work.js';
import type { NfceArtifactStore, NfceWorkerRepositories } from './ports.js';

const DAY_MS = 86_400_000;

/** Enfileira o arquivamento do `nfeProc` na MESMA transação da autorização (ADR-0074). */
export async function scheduleNfceArchive(jobs: JobScheduler, input: { companyId: string; invoiceId: string; correlationId: string | null }): Promise<void> {
  await jobs.enqueue({ queue: 'nfce.archive', payload: { companyId: input.companyId, invoiceId: input.invoiceId }, singletonKey: `${input.invoiceId}:archive`, correlationId: input.correlationId });
}

/** Chave do objeto (ADR-0010): `company/{empresa}/nfce/{aaaa}/{mm}/{nota}/nfce-{sha256}.xml`, mês da autorização em UTC. */
export function nfceArchiveKey(companyId: string, invoiceId: string, authorizedAt: Date, sha256: string): string {
  const month = `${String(authorizedAt.getUTCFullYear())}/${String(authorizedAt.getUTCMonth() + 1).padStart(2, '0')}`;
  return `company/${companyId}/nfce/${month}/${invoiceId}/nfce-${sha256}.xml`;
}

export type NfceArchiveResult = { readonly kind: 'ARCHIVED'; readonly objectKey: string } | { readonly kind: 'ALREADY_ARCHIVED' };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Arquiva o `nfeProc` da NFC-e autorizada no bucket com Object Lock (ADR-0074, molde do ADR-0048):
 *
 * - confere os bytes contra o SHA-256 gravado junto com o XML ANTES de enviar;
 * - grava fora da transação (rede), relê do bucket e só marca arquivado se a releitura bater;
 * - repetir é seguro: a chave tem o hash, e o que já foi arquivado não é enviado de novo;
 * - o XML continua no banco; o bucket é a cópia imutável fora da VPS.
 */
export class NfceXmlArchiver {
  constructor(
    private readonly uow: UnitOfWork<NfceWorkerRepositories>,
    private readonly store: NfceArtifactStore,
    /** Retenção COMPLIANCE contada da autorização. O prazo legal de guarda é decisão do responsável (ADR-0048). */
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('retenção do arquivamento inválida');
  }

  async archive(companyId: string, invoiceId: string, context: AuditContext): Promise<NfceArchiveResult> {
    const stored = await this.uow.inCompany(companyId, (r) => r.invoices.authorizedXml(invoiceId));
    if (stored === undefined) throw new PermanentJobError('CONSUMER_INVOICE_NOT_FOUND');
    if (stored.objectKey !== null) return { kind: 'ALREADY_ARCHIVED' };
    if (stored.xml === null || stored.authorizedAt === null) throw new PermanentJobError('NFCE_XML_MISSING');
    if (stored.sha256 === null) throw new PermanentJobError('NFCE_XML_HASH_MISSING');
    const body = Buffer.from(stored.xml, 'utf8');
    // O XML do banco tem de ser o que foi gravado junto com o hash: senão, nada vai para o bucket.
    if (sha256(body) !== stored.sha256) throw new PermanentJobError('NFCE_XML_HASH_MISMATCH');

    const retainUntil = new Date(stored.authorizedAt.getTime() + this.retentionDays * DAY_MS);
    if (retainUntil.getTime() <= this.now().getTime()) throw new PermanentJobError('NFCE_ARCHIVE_RETENTION_EXPIRED');
    const objectKey = nfceArchiveKey(companyId, invoiceId, stored.authorizedAt, stored.sha256);
    const readBack = await this.store.put({ key: objectKey, body, contentType: 'application/xml', retainUntil });
    if (sha256(readBack) !== stored.sha256) throw new InternalError('NFCE_ARCHIVE_READBACK_MISMATCH');

    return this.uow.inCompany(companyId, async (r): Promise<NfceArchiveResult> => {
      if (!(await r.invoices.markArchived(invoiceId, { objectKey, archivedAt: this.now(), retainUntil }))) return { kind: 'ALREADY_ARCHIVED' };
      await r.audit.record(context, {
        action: 'consumer_invoice.xml_archived',
        subject: { type: 'consumer_invoice', id: invoiceId },
        details: { objectKey, sha256: stored.sha256, retainUntil: retainUntil.toISOString() },
      });
      return { kind: 'ARCHIVED', objectKey };
    });
  }
}
