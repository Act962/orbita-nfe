import type { AuditTrail } from '../../../../shared/application/audit.js';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import type { CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import type { ConstraintErrorMap } from '../../../../shared/infrastructure/database/database-errors.js';
import type { JobScheduler } from '../../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../../shared/application/outbox.js';
import { companyScopedUnitOfWork } from '../../../../shared/infrastructure/database/unit-of-work.js';
import type { DispatcherRepositories, WebhookApiRepositories } from '../../application/ports.js';
import { deliveryRepository, dispatcherRepositories, subscriptionRepository } from './repositories.js';

const WEBHOOK_CONSTRAINTS: ConstraintErrorMap = {};

export function webhookApiUnitOfWork(
  transactions: CompanyTransactions,
  deps: { auditFor: (tx: Transaction) => AuditTrail; jobsFor: (tx: Transaction) => JobScheduler; outboxFor: (tx: Transaction) => EventOutbox },
): UnitOfWork<WebhookApiRepositories> {
  return companyScopedUnitOfWork(
    transactions,
    (tx) => ({
      subscriptions: subscriptionRepository(tx),
      deliveries: deliveryRepository(tx),
      events: deps.outboxFor(tx),
      jobs: deps.jobsFor(tx),
      audit: deps.auditFor(tx),
    }),
    WEBHOOK_CONSTRAINTS,
  );
}

export function webhookDispatcherUnitOfWork(transactions: CompanyTransactions, deps: { jobsFor: (tx: Transaction) => JobScheduler }): UnitOfWork<DispatcherRepositories> {
  return companyScopedUnitOfWork(transactions, (tx) => ({ ...dispatcherRepositories(tx), jobs: deps.jobsFor(tx) }), WEBHOOK_CONSTRAINTS);
}
