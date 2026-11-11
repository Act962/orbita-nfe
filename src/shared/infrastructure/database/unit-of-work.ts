import type { UnitOfWork } from '../../application/unit-of-work.js';
import type { ConstraintErrorMap } from './database-errors.js';
import type { Transaction, CompanyTransactions } from './database.js';

/**
 * Implementação da porta UnitOfWork sobre CompanyTransactions.
 * `constraints` reúne os mapas constraint → erro de negócio dos repositories do módulo.
 */
export function companyScopedUnitOfWork<R>(
  transactions: CompanyTransactions,
  build: (tx: Transaction) => R,
  constraints: ConstraintErrorMap,
): UnitOfWork<R> {
  return {
    inCompany: (companyId, work, options) => transactions.run(companyId, (tx) => work(build(tx)), constraints, options),
  };
}
