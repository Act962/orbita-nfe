/**
 * Fachada pública do módulo NFS-e (ADR-0032).
 */
export { ServiceInvoiceService, type AcceptServiceInvoice, type AcceptResult } from './application/service-invoice-service.js';
export { SubmissionProcessor, DEFAULT_PROCESSOR_OPTIONS, type ProcessResult, type ProcessorOptions } from './application/submission-processor.js';
export { Reconciler, type ReconcileResult } from './application/reconciler.js';
export { ManualResolutionDesk, ResolutionApplier, type ApplyResult, type ResolutionRequest } from './application/manual-resolution.js';
export { UnknownEscalator, type EscalationResult } from './application/unknown-escalator.js';
export { XmlNfseVerifier } from './infrastructure/dps/xml-nfse-verifier.js';
export { nfseDeskReader, nfseDeskUnitOfWork } from './infrastructure/persistence/resolution-repositories.js';
export type { EscalationLevel } from './domain/unknown-escalation.js';
export type {
  ActiveSeries,
  CredentialAccess,
  DpsPreparer,
  EstablishmentReader,
  IssuerCredential,
  NfseDocumentVerifier,
  NfseGateway,
  NfseVerification,
  ServiceInvoiceResolution,
  UnknownAlertSink,
  UnknownInvoiceSummary,
  PreparationResult,
  ProductionGate,
  SeriesAllocator,
  ServiceInvoice,
} from './application/ports.js';
export { nfseApiUnitOfWork, nfseWorkerUnitOfWork, NFSE_CONSTRAINTS } from './infrastructure/persistence/repositories.js';
export { SimulatedNfseGateway, type LookupMode, type SubmitMode } from './infrastructure/gateways/simulated-gateway.js';
export { XmlDpsPreparer, XmlDpsValidator, formatDhEmi } from './infrastructure/dps/xml-dps-preparer.js';
export { buildDpsXml, LAYOUT_PROFILES } from './infrastructure/dps/dps-xml.js';
export type { DpsData } from './domain/dps.js';
export { registerNfseRoutes } from './presentation/http/routes.js';
