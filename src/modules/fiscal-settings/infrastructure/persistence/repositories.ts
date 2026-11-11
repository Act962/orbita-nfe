import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import { ConflictError, NotFoundError } from '../../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type {
  CertificateAvailability,
  DocumentSeriesRepository,
  EstablishmentDirectory,
  EstablishmentProfiles,
  FiscalSettingsRepositories,
  ProductionEnablementRepository,
} from '../../application/fiscal-settings-service.js';
import type { DocumentKind, DocumentSeries, FiscalEnvironment, SeriesStatus } from '../../domain/document-series.js';
import type { EnablementStatus, ProductionEnablement } from '../../domain/production-enablement.js';
import { documentSeries, productionEnablements } from './schema.js';

export const FISCAL_SETTINGS_CONSTRAINTS: ConstraintErrorMap = {
  uq_document_series_key: () =>
    new ConflictError('DOCUMENT_SERIES_ALREADY_EXISTS', 'Já existe esta série para o estabelecimento, a modalidade e o ambiente.'),
  // Defesa em profundidade: a existência é conferida antes; a FK composta cobre corrida e outra empresa.
  fk_document_series_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
  uq_production_enablements_active: () =>
    new ConflictError('PRODUCTION_ALREADY_ENABLED', 'A modalidade já está habilitada para produção neste estabelecimento.'),
  fk_production_enablements_establishment: () => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.'),
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
    async hasActive(establishmentId, kind, environment) {
      const rows = await tx
        .select({ id: documentSeries.id })
        .from(documentSeries)
        .where(
          and(
            eq(documentSeries.establishmentId, establishmentId),
            eq(documentSeries.kind, kind),
            eq(documentSeries.environment, environment),
            eq(documentSeries.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

type EnablementRow = typeof productionEnablements.$inferSelect;

const toEnablement = (row: EnablementRow): ProductionEnablement => ({
  id: row.id,
  companyId: row.companyId,
  establishmentId: row.establishmentId,
  kind: row.kind as DocumentKind,
  status: row.status as EnablementStatus,
  enabledAt: row.enabledAt,
  revokedAt: row.revokedAt,
  revocationReason: row.revocationReason,
});

export function productionEnablementRepository(tx: Transaction): ProductionEnablementRepository {
  return {
    async insert(enablement) {
      // SQL explícito: o Drizzle lista TODAS as colunas no INSERT, e a API só tem INSERT nas
      // colunas de identidade. Status e data ficam no padrão do banco (ACTIVE, now()).
      await tx.execute(sql`
        insert into production_enablements (id, company_id, establishment_id, kind)
        values (${enablement.id}, ${enablement.companyId}, ${enablement.establishmentId}, ${enablement.kind})`);
      const rows = await tx.select().from(productionEnablements).where(eq(productionEnablements.id, enablement.id)).limit(1);
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT sem linha');
      return toEnablement(row);
    },
    async listByEstablishment(establishmentId) {
      const rows = await tx
        .select()
        .from(productionEnablements)
        .where(eq(productionEnablements.establishmentId, establishmentId))
        .orderBy(asc(productionEnablements.kind), desc(productionEnablements.enabledAt));
      return rows.map(toEnablement);
    },
    async revoke(establishmentId, id, reason) {
      const rows = await tx
        .update(productionEnablements)
        .set({ status: 'REVOKED', revokedAt: sql`now()`, revocationReason: reason })
        .where(
          and(
            eq(productionEnablements.id, id),
            eq(productionEnablements.establishmentId, establishmentId),
            eq(productionEnablements.status, 'ACTIVE'),
          ),
        )
        .returning();
      return rows[0] === undefined ? undefined : toEnablement(rows[0]);
    },
    async isEnabled(establishmentId, kind) {
      const rows = await tx
        .select({ id: productionEnablements.id })
        .from(productionEnablements)
        .where(
          and(
            eq(productionEnablements.establishmentId, establishmentId),
            eq(productionEnablements.kind, kind),
            eq(productionEnablements.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

export function fiscalSettingsUnitOfWork(
  transactions: CompanyTransactions,
  ports: {
    establishmentsFor: (tx: Transaction) => EstablishmentDirectory & EstablishmentProfiles;
    certificatesFor: (tx: Transaction) => CertificateAvailability;
    auditFor: (tx: Transaction) => AuditTrail;
  },
): UnitOfWork<FiscalSettingsRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      series: documentSeriesRepository(tx),
      enablements: productionEnablementRepository(tx),
      establishments: ports.establishmentsFor(tx),
      certificates: ports.certificatesFor(tx),
      audit: ports.auditFor(tx),
    }),
    FISCAL_SETTINGS_CONSTRAINTS,
  );
}
