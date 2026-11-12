import { and, eq, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import { ConflictError } from '../../../../shared/application/errors.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { CompanyTransactions, Database, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import { RESOLUTION_ALREADY_REQUESTED } from '../../application/manual-resolution.js';
import type {
  FiscalEnvironment,
  NfseDeskReader,
  NfseDeskRepositories,
  ResolutionRepository,
  ResolutionRequestRepository,
  ServiceInvoiceResolution,
  UnknownInvoiceSummary,
} from '../../application/ports.js';
import type { ResolutionOutcome, ResolutionState } from '../../domain/manual-resolution.js';
import type { ServiceInvoiceStatus } from '../../domain/service-invoice.js';
import { serviceInvoiceResolutions } from './schema.js';

/** Colunas que o operador pode ler de volta (sem o XML). */
const metadataColumns = {
  id: serviceInvoiceResolutions.id,
  companyId: serviceInvoiceResolutions.companyId,
  invoiceId: serviceInvoiceResolutions.invoiceId,
  outcome: serviceInvoiceResolutions.outcome,
  reason: serviceInvoiceResolutions.reason,
  evidenceSha256: serviceInvoiceResolutions.evidenceSha256,
  operator: serviceInvoiceResolutions.operator,
  requestedAt: serviceInvoiceResolutions.requestedAt,
  state: serviceInvoiceResolutions.state,
  resultCode: serviceInvoiceResolutions.resultCode,
  decidedAt: serviceInvoiceResolutions.decidedAt,
};

type MetadataRow = { [K in keyof typeof metadataColumns]: (typeof serviceInvoiceResolutions.$inferSelect)[K] };

const toResolution = (row: MetadataRow): ServiceInvoiceResolution => ({
  ...row,
  outcome: row.outcome as ResolutionOutcome,
  state: row.state as ResolutionState,
});

/** worker-fiscal: lê o pedido inteiro e grava a decisão (compare-and-set a partir de REQUESTED). */
export function resolutionRepository(tx: Transaction): ResolutionRepository {
  return {
    async find(id) {
      const rows = await tx
        .select({ ...metadataColumns, nfseXml: serviceInvoiceResolutions.nfseXml })
        .from(serviceInvoiceResolutions)
        .where(eq(serviceInvoiceResolutions.id, id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? undefined : { ...toResolution(row), nfseXml: row.nfseXml };
    },
    async decide(id, state, resultCode, at) {
      const rows = await tx
        .update(serviceInvoiceResolutions)
        .set({ state, resultCode, decidedAt: at })
        .where(and(eq(serviceInvoiceResolutions.id, id), eq(serviceInvoiceResolutions.state, 'REQUESTED')))
        .returning({ id: serviceInvoiceResolutions.id });
      return rows.length === 1;
    },
  };
}

/** Operador: grava o pedido (só as colunas do pedido; estado e datas ficam no padrão). */
export function resolutionRequestRepository(tx: Transaction): ResolutionRequestRepository {
  return {
    async insert(resolution) {
      await tx.execute(sql`
        insert into service_invoice_resolutions (id, company_id, invoice_id, outcome, reason, evidence_sha256, nfse_xml, operator)
        values (${resolution.id}, ${resolution.companyId}, ${resolution.invoiceId}, ${resolution.outcome}, ${resolution.reason},
          ${resolution.evidenceSha256}, ${resolution.nfseXml}, ${resolution.operator})`);
      const rows = await tx.select(metadataColumns).from(serviceInvoiceResolutions).where(eq(serviceInvoiceResolutions.id, resolution.id)).limit(1);
      if (rows[0] === undefined) throw new Error('INSERT sem linha');
      return toResolution(rows[0]);
    },
  };
}

export const RESOLUTION_CONSTRAINTS = {
  uq_service_invoice_resolutions_open: () => new ConflictError(RESOLUTION_ALREADY_REQUESTED, 'Já há um pedido de resolução aberto para esta NFS-e.'),
};

export function nfseDeskUnitOfWork(
  transactions: CompanyTransactions,
  ports: { readonly auditFor: (tx: Transaction) => AuditTrail; readonly jobsFor: (tx: Transaction) => JobScheduler },
): UnitOfWork<NfseDeskRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({ resolutions: resolutionRequestRepository(tx), audit: ports.auditFor(tx), jobs: ports.jobsFor(tx) }),
    RESOLUTION_CONSTRAINTS,
  );
}

/**
 * Leitura do operador (papel fiscal_admin). Dado de empresa é lido SEMPRE numa transação da
 * empresa (RLS); só a lista de empresas vem da fila, que tem apenas identificadores. As colunas
 * com o pedido do cliente, a DPS assinada e o XML da NFS-e não têm grant para o operador.
 */
export function nfseDeskReader(db: Database, transactions: CompanyTransactions): NfseDeskReader {
  return {
    async companiesWithReconciliation() {
      const rows = await db.execute<{ company_id: string }>(sql`
        select distinct payload->>'companyId' as company_id from jobs
         where queue in ('nfse.reconcile', 'nfse.escalate') and state in ('queued', 'active', 'dead')`);
      return rows.rows.map((r) => r.company_id);
    },
    listUnknown(companyId, sinceBefore, limit) {
      return transactions.run(companyId, async (tx) => {
        const rows = await tx.execute<{
          id: string;
          company_id: string;
          environment: string;
          dps_id: string;
          seq: number;
          since: Date | string;
          lookups: number;
          consecutive_lookup_errors: number;
          open_resolution_id: string | null;
        }>(sql`
          select i.id, i.company_id, i.environment, i.dps_id, a.seq, coalesce(a.sending_at, a.prepared_at) as since,
                 a.lookups, a.consecutive_lookup_errors, r.id as open_resolution_id
            from service_invoices i
            join lateral (
              select seq, sending_at, prepared_at, lookups, consecutive_lookup_errors
                from service_invoice_attempts where invoice_id = i.id order by seq desc limit 1
            ) a on true
            left join service_invoice_resolutions r on r.invoice_id = i.id and r.state = 'REQUESTED'
           where i.status = 'UNKNOWN' and coalesce(a.sending_at, a.prepared_at) <= ${sinceBefore}
           order by since asc
           limit ${limit}`);
        return rows.rows.map(
          (row): UnknownInvoiceSummary => ({
            id: row.id,
            companyId: row.company_id,
            environment: row.environment as FiscalEnvironment,
            dpsId: row.dps_id,
            since: new Date(row.since),
            attemptSeq: row.seq,
            lookups: row.lookups,
            consecutiveLookupErrors: row.consecutive_lookup_errors,
            openResolutionId: row.open_resolution_id,
          }),
        );
      });
    },
    findInvoice(companyId, id) {
      return transactions.run(companyId, async (tx) => {
        const rows = await tx.execute<{ id: string; company_id: string; status: string }>(
          sql`select id, company_id, status from service_invoices where id = ${id} limit 1`,
        );
        const row = rows.rows[0];
        return row === undefined ? undefined : { id: row.id, companyId: row.company_id, status: row.status as ServiceInvoiceStatus };
      });
    },
    findResolution(companyId, id) {
      return transactions.run(companyId, async (tx) => {
        const rows = await tx.select(metadataColumns).from(serviceInvoiceResolutions).where(eq(serviceInvoiceResolutions.id, id)).limit(1);
        return rows[0] === undefined ? undefined : toResolution(rows[0]);
      });
    },
  };
}
