import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import { ConflictError, NotFoundError } from '../../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type { DocumentSeriesRepository, EstablishmentDirectory, FiscalSettingsRepositories } from '../../application/fiscal-settings-service.js';
import type { DocumentKind, DocumentSeries, FiscalEnvironment, SeriesStatus } from '../../domain/document-series.js';
import { documentSeries } from './schema.js';

export const FISCAL_SETTINGS_CONSTRAINTS: ConstraintErrorMap = {
  uq_document_series_key: () =>
    new ConflictError('DOCUMENT_SERIES_ALREADY_EXISTS', 'Já existe esta série para o estabelecimento, a modalidade e o ambiente.'),
  // Defesa em profundidade: a existência é conferida antes; a FK composta cobre corrida e outra empresa.
  fk_document_series_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
};

type Row = typeof documentSeries.$inferSelect;

const toSeries = (row: Row): DocumentSeries => ({
  id: row.id,
  companyId: row.companyId,
  establishmentId: row.establishmentId,
  kind: row.kind as DocumentKind,
  environment: row.environment as FiscalEnvironment,
  series: row.series,
  nextNumber: row.nextNumber,
  maxNumber: row.maxNumber,
  status: row.status as SeriesStatus,
  createdAt: row.createdAt,
});

export function documentSeriesRepository(tx: Transaction): DocumentSeriesRepository {
  return {
    async insert(series) {
      const rows = await tx.insert(documentSeries).values(series).returning();
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING sem linha');
      return toSeries(row);
    },
    async listByEstablishment(establishmentId) {
      const rows = await tx
        .select()
        .from(documentSeries)
        .where(eq(documentSeries.establishmentId, establishmentId))
        .orderBy(asc(documentSeries.kind), asc(documentSeries.environment), asc(documentSeries.series));
      return rows.map(toSeries);
    },
    async allocateNext(seriesId) {
      // UPDATE atômico: a linha fica travada até o fim da transação; concorrentes esperam e
      // recebem o número seguinte. ROLLBACK devolve o número (ADR-0008).
      const allocated = await tx
        .update(documentSeries)
        .set({ nextNumber: sql`${documentSeries.nextNumber} + 1`, updatedAt: sql`now()` })
        .where(and(eq(documentSeries.id, seriesId), eq(documentSeries.status, 'ACTIVE'), lte(documentSeries.nextNumber, documentSeries.maxNumber)))
        .returning({ number: sql<string>`${documentSeries.nextNumber} - 1` });
      const first = allocated[0];
      if (first !== undefined) return { kind: 'ALLOCATED', number: Number(first.number) };

      const current = await tx.select({ status: documentSeries.status }).from(documentSeries).where(eq(documentSeries.id, seriesId)).limit(1);
      const row = current[0];
      if (row === undefined) return { kind: 'NOT_FOUND' };
      return row.status === 'ACTIVE' ? { kind: 'EXHAUSTED' } : { kind: 'INACTIVE' };
    },
  };
}

export function fiscalSettingsUnitOfWork(
  transactions: CompanyTransactions,
  establishmentsFor: (tx: Transaction) => EstablishmentDirectory,
  auditFor: (tx: Transaction) => AuditTrail,
): UnitOfWork<FiscalSettingsRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({ series: documentSeriesRepository(tx), establishments: establishmentsFor(tx), audit: auditFor(tx) }),
    FISCAL_SETTINGS_CONSTRAINTS,
  );
}
