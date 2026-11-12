/**
 * Fachada pública do módulo NFS-e (ADR-0032).
 */
export { ServiceInvoiceService, type AcceptServiceInvoice, type AcceptResult } from './application/service-invoice-service.js';
export { SubmissionProcessor, DEFAULT_PROCESSOR_OPTIONS, type ProcessResult, type ProcessorOptions } from './application/submission-processor.js';
export { Reconciler, type ReconcileResult } from './application/reconciler.js';
export type {
  ActiveSeries,
  CredentialAccess,
  DpsPreparer,
  EstablishmentReader,
  IssuerCredential,
  NfseGateway,
  PreparationResult,
  ProductionGate,
  SeriesAllocator,
  ServiceInvoice,
} from './application/ports.js';
export { nfseApiUnitOfWork, nfseWorkerUnitOfWork, NFSE_CONSTRAINTS } from './infrastructure/persistence/repositories.js';
export { SimulatedNfseGateway, type LookupMode, type SubmitMode } from './infrastructure/gateways/simulated-gateway.js';
