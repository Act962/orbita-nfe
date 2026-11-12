import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { ConflictError } from '../../../../shared/application/errors.js';
import { CANCELLATION_RACE } from '../../application/cancellation.js';
import type { Transaction } from '../../../../shared/infrastructure/database/database.js';
import type { CancellationRepository, CancellationRequestRepository, ServiceInvoiceCancellation } from '../../application/ports.js';
import type { CancellationReasonCode, CancellationState } from '../../domain/cancellation.js';
import { serviceInvoiceCancellations as c } from './schema.js';

export const CANCELLATION_CONSTRAINTS = {
  uq_service_invoice_cancellations_active: () => new ConflictError(CANCELLATION_RACE, 'Pedido de cancelamento repetido em paralelo.'),
};

/** Colunas lidas (sem os XML, que são grandes). */
const columns = {
  id: c.id,
  companyId: c.companyId,
  invoiceId: c.invoiceId,
  clientApplicationId: c.clientApplicationId,
  requestHash: c.requestHash,
  reasonCode: c.reasonCode,
  reasonText: c.reasonText,
  state: c.state,
  leaseUntil: c.leaseUntil,
  signedSha256: c.signedSha256,
  sendingAt: c.sendingAt,
  attempts: c.attempts,
  lookups: c.lookups,
  firstNotFoundAt: c.firstNotFoundAt,
  consecutiveLookupErrors: c.consecutiveLookupErrors,
  outcomeCode: c.outcomeCode,
  rejectionMessage: c.rejectionMessage,
  registeredAt: c.registeredAt,
  failureCode: c.failureCode,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
};

type Row = { [K in keyof typeof columns]: (typeof c.$inferSelect)[K] };

const toCancellation = (row: Row): ServiceInvoiceCancellation => ({
  ...row,
  reasonCode: row.reasonCode as CancellationReasonCode,
  state: row.state as CancellationState,
});

async function one(tx: Transaction, where: ReturnType<typeof and>): Promise<ServiceInvoiceCancellation | undefined> {
  const rows = await tx.select(columns).from(c).where(where).orderBy(desc(c.createdAt)).limit(1);
  return rows[0] === undefined ? undefined : toCancellation(rows[0]);
}

export function cancellationRequestRepository(tx: Transaction): CancellationRequestRepository {
  return {
    findActive: (invoiceId) => one(tx, and(eq(c.invoiceId, invoiceId), notInArray(c.state, ['REJECTED', 'FAILED']))),
    findLatest: (invoiceId) => one(tx, and(eq(c.invoiceId, invoiceId))),
    async insert(cancellation) {
      // SQL explícito: a API só tem INSERT nas colunas do pedido.
      await tx.execute(sql`
        insert into service_invoice_cancellations (id, company_id, invoice_id, client_application_id, request_hash, reason_code, reason_text)
        values (${cancellation.id}, ${cancellation.companyId}, ${cancellation.invoiceId}, ${cancellation.clientApplicationId},
          ${cancellation.requestHash}, ${cancellation.reasonCode}, ${cancellation.reasonText})`);
      const found = await one(tx, and(eq(c.id, cancellation.id)));
      if (found === undefined) throw new Error('INSERT sem linha');
      return found;
    },
  };
}

export function cancellationRepository(tx: Transaction): CancellationRepository {
  return {
    find: (id) => one(tx, and(eq(c.id, id))),
    async signedXml(id) {
      const rows = await tx.select({ xml: c.signedXml }).from(c).where(eq(c.id, id)).limit(1);
      return rows[0]?.xml ?? undefined;
    },
    async changeState(id, from, to, change = {}) {
      const rows = await tx
        .update(c)
        .set({
          state: to,
          ...(change.leaseUntil === undefined ? {} : { leaseUntil: change.leaseUntil }),
          ...(change.clearSending === undefined ? {} : { sendingAt: null }),
          ...(change.outcomeCode === undefined ? {} : { outcomeCode: change.outcomeCode }),
          ...(change.rejectionMessage === undefined ? {} : { rejectionMessage: change.rejectionMessage }),
          ...(change.eventXml === undefined ? {} : { eventXml: change.eventXml }),
          ...(change.registeredAt === undefined ? {} : { registeredAt: change.registeredAt }),
          ...(change.failureCode === undefined ? {} : { failureCode: change.failureCode }),
          ...(change.resetLookups === undefined ? {} : { firstNotFoundAt: null, consecutiveLookupErrors: 0 }),
        })
        .where(and(eq(c.id, id), eq(c.state, from)))
        .returning({ id: c.id });
      return rows.length === 1;
    },
    async storeSigned(id, signed) {
      await tx.update(c).set({ signedXml: signed.xml, signedSha256: signed.sha256, layoutPackage: signed.layoutPackage }).where(eq(c.id, id));
    },
    async markSending(id, at) {
      await tx
        .update(c)
        .set({ sendingAt: at, attempts: sql`${c.attempts} + 1` })
        .where(eq(c.id, id));
    },
    async recordLookup(id, state) {
      await tx
        .update(c)
        .set({ lookups: sql`${c.lookups} + 1`, firstNotFoundAt: state.firstNotFoundAt, consecutiveLookupErrors: state.consecutiveLookupErrors })
        .where(eq(c.id, id));
    },
  };
}
