import { sql } from 'drizzle-orm';
import type { Transaction } from '../../../../shared/infrastructure/database/database.js';
import type { ArchivedXmlCheckRepository, ArchivedXmlDue, ArchivedXmlKind } from '../../application/ports.js';

interface DueRow extends Record<string, unknown> {
  kind: ArchivedXmlKind;
  document_id: string;
  invoice_id: string;
  xml: string;
  sha256: string;
  object_key: string;
  retain_until: string | Date;
  failure_code: string | null;
}

/**
 * Conferência periódica dos XML arquivados (ADR-0051), sempre na transação da empresa (RLS). A
 * empresa da linha nova vem do contexto (`app_current_company()`), nunca de parâmetro.
 */
export function archivedXmlCheckRepository(tx: Transaction): ArchivedXmlCheckRepository {
  const upsert = async (kind: ArchivedXmlKind, documentId: string, set: { verifiedAt: Date | null; failedAt: Date | null; failureCode: string | null }) => {
    await tx.execute(sql`
      insert into archived_xml_checks (company_id, kind, document_id, last_verified_at, last_failed_at, failure_code)
      values (app_current_company(), ${kind}, ${documentId}, ${set.verifiedAt}::timestamptz, ${set.failedAt}::timestamptz, ${set.failureCode})
      on conflict (company_id, kind, document_id) do update set
        last_verified_at = coalesce(excluded.last_verified_at, archived_xml_checks.last_verified_at),
        last_failed_at = coalesce(excluded.last_failed_at, archived_xml_checks.last_failed_at),
        failure_code = excluded.failure_code`);
  };
  return {
    async due({ verifiedBefore, failedBefore, retainedAfter, limit }) {
      const rows = await tx.execute<DueRow>(sql`
        select kind, document_id, invoice_id, xml, sha256, object_key, retain_until, failure_code from (
          select 'NFSE' as kind, i.id as document_id, i.id as invoice_id, i.nfse_xml as xml, i.nfse_xml_sha256 as sha256,
                 i.nfse_xml_object_key as object_key, i.nfse_xml_retain_until as retain_until,
                 coalesce(k.last_verified_at, i.nfse_xml_archived_at) as verified_at, k.last_failed_at, k.failure_code
            from service_invoices i
            left join archived_xml_checks k on k.company_id = i.company_id and k.kind = 'NFSE' and k.document_id = i.id
           where i.nfse_xml_object_key is not null
          union all
          select 'CANCELLATION_EVENT', x.id, x.invoice_id, x.event_xml, x.event_xml_sha256,
                 x.event_xml_object_key, x.event_xml_retain_until,
                 coalesce(k.last_verified_at, x.event_xml_archived_at), k.last_failed_at, k.failure_code
            from service_invoice_cancellations x
            left join archived_xml_checks k on k.company_id = x.company_id and k.kind = 'CANCELLATION_EVENT' and k.document_id = x.id
           where x.event_xml_object_key is not null
        ) d
        where d.verified_at < ${verifiedBefore}::timestamptz
          and (d.last_failed_at is null or d.last_failed_at < ${failedBefore}::timestamptz)
          and d.retain_until > ${retainedAfter}::timestamptz
        order by d.verified_at, d.document_id
        limit ${limit}`);
      return rows.rows.map(
        (r): ArchivedXmlDue => ({
          kind: r.kind,
          documentId: r.document_id,
          invoiceId: r.invoice_id,
          xml: r.xml,
          sha256: r.sha256,
          objectKey: r.object_key,
          // O execute cru devolve timestamptz como texto.
          retainUntil: new Date(r.retain_until),
          failureCode: r.failure_code,
        }),
      );
    },
    recordVerified: (kind, documentId, at) => upsert(kind, documentId, { verifiedAt: at, failedAt: null, failureCode: null }),
    recordFailed: (kind, documentId, failureCode, at) => upsert(kind, documentId, { verifiedAt: null, failedAt: at, failureCode }),
  };
}
