import type { AuditTrail } from '../../../../shared/application/audit.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../../shared/application/outbox.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type { CertificateExpiryRepositories } from '../../application/expiry-notifier.js';
import type { CertificateApiRepositories, CertificateWorkerRepositories, CompanyLookup, EstablishmentLookup } from '../../application/ports.js';
import {
  CERTIFICATE_CONSTRAINTS,
  certificateExpiryNoticeRepository,
  certificateExpiryReader,
  certificateRepository,
  sealedCertificateRepository,
} from './repositories.js';

export function certificateApiUnitOfWork(
  transactions: CompanyTransactions,
  deps: {
    establishmentsFor: (tx: Transaction) => EstablishmentLookup;
    auditFor: (tx: Transaction) => AuditTrail;
    jobsFor: (tx: Transaction) => JobScheduler;
    outboxFor: (tx: Transaction) => EventOutbox;
  },
): UnitOfWork<CertificateApiRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      certificates: certificateRepository(tx),
      establishments: deps.establishmentsFor(tx),
      audit: deps.auditFor(tx),
      jobs: deps.jobsFor(tx),
      events: deps.outboxFor(tx),
    }),
    CERTIFICATE_CONSTRAINTS,
  );
}

export function certificateWorkerUnitOfWork(
  transactions: CompanyTransactions,
  deps: {
    companyFor: (tx: Transaction) => CompanyLookup;
    auditFor: (tx: Transaction) => AuditTrail;
    outboxFor: (tx: Transaction) => EventOutbox;
    jobsFor: (tx: Transaction) => JobScheduler;
  },
): UnitOfWork<CertificateWorkerRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      certificates: sealedCertificateRepository(tx),
      company: deps.companyFor(tx),
      audit: deps.auditFor(tx),
      events: deps.outboxFor(tx),
      jobs: deps.jobsFor(tx),
    }),
    CERTIFICATE_CONSTRAINTS,
  );
}

/** Avisos de vencimento (papel fiscal_general). */
export function certificateExpiryUnitOfWork(
  transactions: CompanyTransactions,
  deps: { outboxFor: (tx: Transaction) => EventOutbox },
): UnitOfWork<CertificateExpiryRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({ certificates: certificateExpiryReader(tx), notices: certificateExpiryNoticeRepository(tx), events: deps.outboxFor(tx) }),
    CERTIFICATE_CONSTRAINTS,
  );
}
