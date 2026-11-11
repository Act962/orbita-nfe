import { asc, eq, sql } from 'drizzle-orm';
import type { AuditTrail } from '../../../../shared/application/audit.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import { ConflictError } from '../../../../shared/application/errors.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type { AccessGrants, EstablishmentRepository, CompanyRepositories, CompanyRepository } from '../../application/company-service.js';
import type { Establishment, EstablishmentStatus, Company, CompanyStatus } from '../../domain/company.js';
import { establishments, companies } from './schema.js';

/** Constraints que a regra de negócio prevê (as demais são bug → 500). */
export const COMPANY_CONSTRAINTS: ConstraintErrorMap = {
  uq_companies_root_cnpj: () => new ConflictError('COMPANY_ALREADY_REGISTERED', 'Já existe uma empresa com esta raiz de CNPJ.'),
  uq_establishments_cnpj: () => new ConflictError('ESTABLISHMENT_ALREADY_REGISTERED', 'Já existe um estabelecimento com este CNPJ.'),
};

type CompanyRow = typeof companies.$inferSelect;
type EstablishmentRow = typeof establishments.$inferSelect;

const toCompany = (row: CompanyRow): Company => ({ ...row, status: row.status as CompanyStatus });
const toEstablishment = (row: EstablishmentRow): Establishment => ({ ...row, status: row.status as EstablishmentStatus });

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING sem linha');
  return row;
}

export function companyRepository(tx: Transaction): CompanyRepository {
  return {
    async insert(company) {
      return toCompany(one(await tx.insert(companies).values(company).returning()));
    },
    async current() {
      // RLS: a única linha visível é a da empresa do contexto; o filtro explícito é defesa extra.
      const rows = await tx.select().from(companies).where(eq(companies.id, sql`app_current_company()`)).limit(1);
      return rows[0] === undefined ? undefined : toCompany(rows[0]);
    },
  };
}

export function establishmentRepository(tx: Transaction): EstablishmentRepository {
  return {
    async insert(establishment) {
      return toEstablishment(one(await tx.insert(establishments).values(establishment).returning()));
    },
    async findById(id) {
      const rows = await tx.select().from(establishments).where(eq(establishments.id, id)).limit(1);
      return rows[0] === undefined ? undefined : toEstablishment(rows[0]);
    },
    async list() {
      const rows = await tx.select().from(establishments).orderBy(asc(establishments.cnpj));
      return rows.map(toEstablishment);
    },
  };
}

export function companyUnitOfWork(
  transactions: CompanyTransactions,
  accessGrantsFor: (tx: Transaction) => AccessGrants,
  auditFor: (tx: Transaction) => AuditTrail,
  jobsFor: (tx: Transaction) => JobScheduler,
): UnitOfWork<CompanyRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      companies: companyRepository(tx),
      establishments: establishmentRepository(tx),
      accessGrants: accessGrantsFor(tx),
      audit: auditFor(tx),
      jobs: jobsFor(tx),
    }),
    COMPANY_CONSTRAINTS,
  );
}
