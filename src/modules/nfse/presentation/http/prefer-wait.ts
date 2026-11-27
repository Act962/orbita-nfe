import type { WaitPolicy } from '../../../../shared/presentation/http/prefer-wait.js';
import type { ServiceInvoice, ServiceInvoiceCancellation } from '../../application/ports.js';

/**
 * Políticas do `Prefer: wait` da NFS-e: emissão e substituição (ADR-0053) e pedido de cancelamento
 * (ADR-0053, acréscimo de 24/11). O mecanismo é comum (shared/presentation/http/prefer-wait).
 */
export { MAX_WAIT_SECONDS, preferredWait, settle, waitWhileInFlight, type Settled, type WaitPolicy } from '../../../../shared/presentation/http/prefer-wait.js';

export const INVOICE_WAIT: WaitPolicy<ServiceInvoice> = {
  inFlight: (i) => i.status === 'PENDING' || i.status === 'PROCESSING',
  final: (i) => ['AUTHORIZED', 'REJECTED', 'FAILED', 'CANCELLED', 'SUBSTITUTED'].includes(i.status),
};

export const CANCELLATION_WAIT: WaitPolicy<ServiceInvoiceCancellation> = {
  inFlight: (c) => c.state === 'PENDING' || c.state === 'PROCESSING',
  final: (c) => c.state === 'REGISTERED' || c.state === 'REJECTED' || c.state === 'FAILED',
};
