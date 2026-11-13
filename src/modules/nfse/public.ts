/**
 * Fachada pública do módulo NFS-e (ADR-0032).
 */
export { ServiceInvoiceService, type AcceptServiceInvoice, type AcceptResult } from './application/service-invoice-service.js';
export { SubmissionProcessor, DEFAULT_PROCESSOR_OPTIONS, type ProcessResult, type ProcessorOptions } from './application/submission-processor.js';
export { Reconciler, type ReconcileResult } from './application/reconciler.js';
export {
  CancellationProcessor,
  CancellationReconciler,
  CancellationService,
  DEFAULT_CANCELLATION_OPTIONS,
  type CancellationOptions,
  type CancellationProcessResult,
  type CancellationReconcileResult,
  type CancellationRequestResult,
} from './application/cancellation.js';
export { XmlCancellationPreparer, buildCancellationXml } from './infrastructure/events/cancellation-xml.js';
export { CANCELLATION_REASON_CODES, type CancellationState } from './domain/cancellation.js';
export { ManualResolutionDesk, ResolutionApplier, type ApplyResult, type ResolutionRequest } from './application/manual-resolution.js';
export { UnknownEscalator, type EscalationResult } from './application/unknown-escalator.js';
export { XmlNfseVerifier } from './infrastructure/dps/xml-nfse-verifier.js';
export { nfseDeskReader, nfseDeskUnitOfWork } from './infrastructure/persistence/resolution-repositories.js';
export type { EscalationLevel } from './domain/unknown-escalation.js';
export { route, SUPPORTED_CHANNELS, type RoutingChannel, type RoutingDecision, type RoutingTable } from './domain/routing.js';
export { loadRoutingTable, RoutingTableError } from './infrastructure/routing/routing-table.js';
export type {
  ActiveSeries,
  CancellationPreparer,
  CredentialAccess,
  DpsPreparer,
  EstablishmentReader,
  IssuerCredential,
  NfseDocumentVerifier,
  GatewayContext,
  NfseGateway,
  NfseVerification,
  ServiceInvoiceCancellation,
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
export { ChannelRoutedGateway } from './infrastructure/gateways/channel-router.js';
export { NationalNfseGateway, SEFIN_NACIONAL, TERESINA_DSF, type NationalEndpointProfile } from './infrastructure/gateways/national/national-gateway.js';
export { XmlDpsPreparer, XmlDpsValidator, formatDhEmi } from './infrastructure/dps/xml-dps-preparer.js';
export { buildDpsId } from './domain/dps-id.js';
export { checkDpsRules } from './domain/dps-rules.js';
export { checkChannelRules } from './domain/channel-rules.js';
export { layoutEnvironmentOf } from './domain/routing.js';
export { brasiliaDate } from './domain/dps.js';
export { buildDpsXml, LAYOUT_PROFILES } from './infrastructure/dps/dps-xml.js';
export type { DpsData } from './domain/dps.js';
export { registerNfseRoutes } from './presentation/http/routes.js';
