import type { KeyObject } from 'node:crypto';
import type { AuditTrail } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../shared/application/outbox.js';
import type { DpsData } from '../domain/dps.js';
import type { CancellationReasonCode, CancellationState } from '../domain/cancellation.js';
import type { ResolutionOutcome, ResolutionState } from '../domain/manual-resolution.js';
import type { AttemptState, ServiceInvoiceStatus } from '../domain/service-invoice.js';
import type { SubstitutionReasonCode } from '../domain/substitution.js';
import type { EscalationLevel } from '../domain/unknown-escalation.js';

export type FiscalEnvironment = 'PRODUCTION' | 'HOMOLOGATION';

/** Na SUBSTITUTA (ADR-0036): a nota original e o grupo `subst` da DPS. Imutável. */
export interface SubstitutionOf {
  readonly invoiceId: string;
  /** `chSubstda`: chave de acesso da original. */
  readonly accessKey: string;
  readonly reasonCode: SubstitutionReasonCode;
  readonly reasonText: string | null;
}

export interface ServiceInvoice {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly clientApplicationId: string;
  readonly environment: FiscalEnvironment;
  readonly seriesId: string;
  readonly series: string;
  readonly number: number;
  readonly dpsId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly externalReference: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Canal e versão da tabela de roteamento gravados na aceitação (ADR-0028). */
  readonly routingChannel: string | null;
  readonly routingTableVersion: string | null;
  readonly status: ServiceInvoiceStatus;
  readonly leaseUntil: Date | null;
  readonly signedDpsSha256: string | null;
  readonly layoutPackage: string | null;
  readonly nfseAccessKey: string | null;
  /** `infNFSe/cStat` do XML autorizado (ADR-0054); nulo se o XML não o trouxer. */
  readonly nfseStatusCode: string | null;
  readonly authorizedAt: Date | null;
  readonly rejectionCode: string | null;
  readonly rejectionMessage: string | null;
  /** Todos os erros da rejeição (ADR-0059); nulo antes dele ou sem rejeição. */
  readonly rejectionErrors: readonly RejectionError[] | null;
  readonly failureCode: string | null;
  /** Esta nota substitui outra (null numa emissão comum). */
  readonly substitution: SubstitutionOf | null;
  /** Na original SUBSTITUTED: a substituta autorizada. */
  readonly substitutedById: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewServiceInvoice = Pick<
  ServiceInvoice,
  | 'id'
  | 'companyId'
  | 'establishmentId'
  | 'clientApplicationId'
  | 'environment'
  | 'seriesId'
  | 'series'
  | 'number'
  | 'dpsId'
  | 'idempotencyKey'
  | 'requestHash'
  | 'externalReference'
  | 'payload'
  | 'routingChannel'
  | 'routingTableVersion'
  | 'substitution'
>;

export type AttemptOutcome = 'AUTHORIZED' | 'REJECTED' | 'NOT_SENT' | 'UNKNOWN' | 'ALREADY_EXISTS' | 'RECOVERED_NOT_SENT' | 'RECOVERED_UNKNOWN';

export interface TransmissionAttempt {
  readonly id: string;
  readonly invoiceId: string;
  readonly seq: number;
  readonly state: AttemptState;
  readonly payloadSha256: string;
  readonly preparedAt: Date;
  readonly sendingAt: Date | null;
  readonly closedAt: Date | null;
  readonly outcome: AttemptOutcome | null;
  readonly outcomeCode: string | null;
  readonly lookups: number;
  readonly firstNotFoundAt: Date | null;
  readonly consecutiveLookupErrors: number;
}

// ------------------------------------------------------------------ portas de outros módulos

export interface IssuerEstablishment {
  readonly id: string;
  readonly cnpj: string;
  readonly municipalityCode: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface EstablishmentReader {
  find(establishmentId: string): Promise<IssuerEstablishment | undefined>;
}

export interface ActiveSeries {
  readonly id: string;
  readonly series: string;
}

export interface SeriesAllocator {
  /** Séries ATIVAS de DPS do estabelecimento no ambiente. */
  activeSeries(establishmentId: string, environment: FiscalEnvironment): Promise<readonly ActiveSeries[]>;
  /** Número na transação corrente (ADR-0008): rollback devolve o número. */
  allocate(seriesId: string): Promise<number>;
}

export interface ProductionGate {
  isEnabled(establishmentId: string): Promise<boolean>;
}

// ------------------------------------------------------------------ repositórios

export interface ServiceInvoiceRepository {
  findById(id: string): Promise<ServiceInvoice | undefined>;
  findByIdempotencyKey(clientApplicationId: string, key: string): Promise<ServiceInvoice | undefined>;
  /** Documento com a referência ainda "ocupada" (não REJECTED/FAILED) no ambiente (ADR-0047). */
  findActiveByExternalReference(clientApplicationId: string, environment: FiscalEnvironment, reference: string): Promise<ServiceInvoice | undefined>;
  /** Todas as notas da referência no ambiente, da mais nova para a mais antiga, até `limit` (ADR-0047). */
  listByExternalReference(clientApplicationId: string, environment: FiscalEnvironment, reference: string, limit: number): Promise<readonly ServiceInvoice[]>;
  insert(invoice: NewServiceInvoice): Promise<ServiceInvoice>;
  /**
   * Serializa, até o fim da transação, os pedidos que mudam o destino de uma nota autorizada
   * (cancelamento e substituição). Trava consultiva: não exige privilégio de UPDATE.
   */
  lockForEvents(invoiceId: string): Promise<void>;
  /** Substituta que ainda ocupa a original (não REJECTED/FAILED). */
  findActiveSubstitute(originalId: string): Promise<ServiceInvoice | undefined>;
  /** XML autorizado e o hash gravado junto (download, ADR-0050). */
  storedXml(id: string): Promise<StoredXml | undefined>;
  /** Metadados de diagnóstico (ADR-0055): arquivamento e tentativas de transmissão, sem XML. */
  diagnostics(id: string): Promise<InvoiceDiagnostics>;
}

export interface InvoiceDiagnostics {
  readonly archive: { readonly sha256: string | null; readonly archivedAt: Date | null; readonly retainUntil: Date | null };
  /** Da primeira para a última. */
  readonly attempts: readonly TransmissionAttempt[];
}

/** XML guardado no banco com o SHA-256 gravado na mesma transação (ADR-0048, ADR-0049). */
export interface StoredXml {
  readonly xml: string | null;
  /** Nulo só em linha anterior às migrations 0024/0026. */
  readonly sha256: string | null;
}

export interface ServiceInvoiceStatusChange {
  readonly leaseUntil?: Date | null;
  readonly signedDps?: { readonly xml: string; readonly sha256: string; readonly layoutPackage: string };
  readonly authorization?: { readonly accessKey: string; readonly nfseXml: string; readonly authorizedAt: Date };
  readonly rejection?: { readonly code: string; readonly message: string; readonly errors: readonly RejectionError[] };
  readonly failureCode?: string;
  /** Original → SUBSTITUTED: a substituta autorizada. */
  readonly substitutedBy?: string;
}

export interface ServiceInvoiceWorkerRepository {
  findById(id: string): Promise<ServiceInvoice | undefined>;
  /** XML assinado gravado (o mesmo em toda retransmissão). */
  signedDps(id: string): Promise<string | undefined>;
  /** Compare-and-set: muda o estado só se ainda for `from`. Devolve se mudou. */
  changeStatus(id: string, from: ServiceInvoiceStatus, to: ServiceInvoiceStatus, change?: ServiceInvoiceStatusChange): Promise<boolean>;
  /** Grava a DPS assinada (uma única vez) sem mudar o estado. */
  storeSignedDps(id: string, signed: NonNullable<ServiceInvoiceStatusChange['signedDps']>): Promise<void>;
  /** XML autorizado e a situação do arquivamento (ADR-0048). */
  authorizedXml(id: string): Promise<AuthorizedXml | undefined>;
  /** Grava o arquivamento uma única vez. Devolve se gravou (falso: já estava arquivado). */
  markArchived(id: string, archive: { readonly objectKey: string; readonly archivedAt: Date; readonly retainUntil: Date }): Promise<boolean>;
}

export interface AuthorizedXml {
  readonly companyId: string;
  readonly xml: string | null;
  /** Gravado junto com o XML; nulo só em nota autorizada antes da migration 0024. */
  readonly sha256: string | null;
  readonly authorizedAt: Date | null;
  readonly objectKey: string | null;
}

/**
 * Object storage dos artefatos fiscais (ADR-0010, ADR-0048). `put` grava com retenção COMPLIANCE
 * e devolve os bytes relidos do bucket, para o chamador conferir o hash.
 */
export interface NfseArtifactStore {
  put(object: { readonly key: string; readonly body: Buffer; readonly contentType: string; readonly retainUntil: Date }): Promise<Buffer>;
  /** Lê o objeto e a trava (ADR-0051). `undefined` se o objeto não existe. */
  read(key: string): Promise<StoredArtifact | undefined>;
}

export interface StoredArtifact {
  readonly body: Buffer;
  /** `COMPLIANCE` esperado; outro valor (ou nenhum) é objeto sem a trava pedida. */
  readonly lockMode: string | null;
  readonly retainUntil: Date | null;
}

// ------------------------------------------------------------------ conferência periódica (ADR-0051)

/** Documentos arquivados conferidos periodicamente; a NFC-e entrou no ADR-0075. */
export type ArchivedXmlKind = 'NFSE' | 'CANCELLATION_EVENT' | 'NFCE';

/** XML arquivado na vez de ser conferido: o do banco, o hash gravado e onde está no bucket. */
export interface ArchivedXmlDue {
  readonly kind: ArchivedXmlKind;
  /** Nota (NFSE) ou pedido de cancelamento (CANCELLATION_EVENT). */
  readonly documentId: string;
  /** A nota, nos dois casos: é o assunto da auditoria. */
  readonly invoiceId: string;
  readonly xml: string;
  readonly sha256: string;
  readonly objectKey: string;
  readonly retainUntil: Date;
  /** A última falha ainda sem conferência boa depois dela. */
  readonly failureCode: string | null;
}

export interface ArchivedXmlCheckRepository {
  /**
   * Os mais atrasados primeiro: arquivados sem conferência boa desde `verifiedBefore` e sem falha
   * desde `failedBefore` (a falha volta a ser conferida, e alertada, uma vez por intervalo).
   */
  due(input: { readonly verifiedBefore: Date; readonly failedBefore: Date; readonly retainedAfter: Date; readonly limit: number }): Promise<readonly ArchivedXmlDue[]>;
  recordVerified(kind: ArchivedXmlKind, documentId: string, at: Date): Promise<void>;
  recordFailed(kind: ArchivedXmlKind, documentId: string, failureCode: string, at: Date): Promise<void>;
}

export interface AttemptRepository {
  /** Tentativa aberta (PREPARED ou SENDING), se houver. */
  open(invoiceId: string): Promise<TransmissionAttempt | undefined>;
  last(invoiceId: string): Promise<TransmissionAttempt | undefined>;
  /** Alguma tentativa chegou a SENDING? (então FAILED fica proibido) */
  anySent(invoiceId: string): Promise<boolean>;
  insert(attempt: { id: string; companyId: string; invoiceId: string; seq: number; payloadSha256: string }): Promise<TransmissionAttempt>;
  markSending(attemptId: string, at: Date): Promise<void>;
  close(attemptId: string, outcome: AttemptOutcome, outcomeCode: string | null, at: Date): Promise<void>;
  recordLookup(attemptId: string, state: { firstNotFoundAt: Date | null; consecutiveLookupErrors: number }): Promise<void>;
}

// ------------------------------------------------------------------ cancelamento (ADR-0035)

export interface ServiceInvoiceCancellation {
  readonly id: string;
  readonly companyId: string;
  readonly invoiceId: string;
  readonly clientApplicationId: string;
  readonly requestHash: string;
  readonly reasonCode: CancellationReasonCode;
  readonly reasonText: string;
  readonly state: CancellationState;
  readonly leaseUntil: Date | null;
  readonly signedSha256: string | null;
  /** Envio em curso ou último envio: base da reconciliação e prova de "pode ter saído". */
  readonly sendingAt: Date | null;
  readonly attempts: number;
  readonly lookups: number;
  readonly firstNotFoundAt: Date | null;
  readonly consecutiveLookupErrors: number;
  /** Último resultado do autorizador (código de transporte, rejeição ou ALREADY_EXISTS). */
  readonly outcomeCode: string | null;
  readonly rejectionMessage: string | null;
  /** Todos os erros da rejeição do evento (ADR-0059); nulo antes dele ou sem rejeição. */
  readonly rejectionErrors: readonly RejectionError[] | null;
  readonly registeredAt: Date | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewCancellation = Pick<ServiceInvoiceCancellation, 'id' | 'companyId' | 'invoiceId' | 'clientApplicationId' | 'requestHash' | 'reasonCode' | 'reasonText'>;

/** API: pedido e consulta. */
export interface CancellationRequestRepository {
  /** Pedido que ainda ocupa a nota (não REJECTED/FAILED). */
  findActive(invoiceId: string): Promise<ServiceInvoiceCancellation | undefined>;
  /** Pedido mais recente da nota, em qualquer estado. */
  findLatest(invoiceId: string): Promise<ServiceInvoiceCancellation | undefined>;
  /** Todos os pedidos da nota, do mais antigo para o mais novo (diagnóstico, ADR-0055). */
  listByInvoice(invoiceId: string): Promise<readonly ServiceInvoiceCancellation[]>;
  insert(cancellation: NewCancellation): Promise<ServiceInvoiceCancellation>;
  /** XML do evento registrado e o hash (download, ADR-0050). */
  storedEventXml(id: string): Promise<StoredXml | undefined>;
}

export interface CancellationChange {
  readonly leaseUntil?: Date | null;
  /** Zera a marca de envio no início de um processamento (a recuperação lê esta marca). */
  readonly clearSending?: true;
  readonly outcomeCode?: string | null;
  readonly rejectionMessage?: string;
  readonly rejectionErrors?: readonly RejectionError[];
  readonly eventXml?: string;
  readonly registeredAt?: Date;
  readonly failureCode?: string;
  /** Recomeço da reconciliação depois de uma retransmissão. */
  readonly resetLookups?: true;
}

/** worker-fiscal. */
export interface CancellationRepository {
  find(id: string): Promise<ServiceInvoiceCancellation | undefined>;
  signedXml(id: string): Promise<string | undefined>;
  /** Compare-and-set a partir de `from`. */
  changeState(id: string, from: CancellationState, to: CancellationState, change?: CancellationChange): Promise<boolean>;
  storeSigned(id: string, signed: { readonly xml: string; readonly sha256: string; readonly layoutPackage: string }): Promise<void>;
  /** Commit ANTES da rede: a partir daqui o pedido pode ter saído. */
  markSending(id: string, at: Date): Promise<void>;
  recordLookup(id: string, state: { firstNotFoundAt: Date | null; consecutiveLookupErrors: number }): Promise<void>;
  /** XML do evento registrado e a situação do arquivamento (ADR-0049). */
  eventXml(id: string): Promise<CancellationEventXml | undefined>;
  /** Grava o arquivamento uma única vez. Devolve se gravou (falso: já estava arquivado). */
  markEventArchived(id: string, archive: { readonly objectKey: string; readonly archivedAt: Date; readonly retainUntil: Date }): Promise<boolean>;
}

export interface CancellationEventXml {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly xml: string | null;
  readonly sha256: string | null;
  readonly registeredAt: Date | null;
  readonly objectKey: string | null;
}

// ------------------------------------------------------------------ resolução manual (ADR-0034)

export interface ServiceInvoiceResolution {
  readonly id: string;
  readonly companyId: string;
  readonly invoiceId: string;
  readonly outcome: ResolutionOutcome;
  readonly reason: string;
  readonly evidenceSha256: string;
  readonly operator: string;
  readonly requestedAt: Date;
  readonly state: ResolutionState;
  readonly resultCode: string | null;
  readonly decidedAt: Date | null;
}

export interface NewResolution {
  readonly id: string;
  readonly companyId: string;
  readonly invoiceId: string;
  readonly outcome: ResolutionOutcome;
  readonly reason: string;
  readonly evidenceSha256: string;
  readonly nfseXml: string | null;
  readonly operator: string;
}

/** Lado do worker-fiscal: lê o pedido inteiro (com o XML) e grava a decisão uma vez. */
export interface ResolutionRepository {
  find(id: string): Promise<(ServiceInvoiceResolution & { readonly nfseXml: string | null }) | undefined>;
  /** Compare-and-set a partir de REQUESTED. Devolve se decidiu. */
  decide(id: string, state: 'APPLIED' | 'REFUSED', resultCode: string, at: Date): Promise<boolean>;
}

/** Lado do operador: grava o pedido na transação da empresa. */
export interface ResolutionRequestRepository {
  insert(resolution: NewResolution): Promise<ServiceInvoiceResolution>;
}

export interface NfseDeskRepositories {
  readonly resolutions: ResolutionRequestRepository;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
}

/** Nota em UNKNOWN no painel de pendências: só metadados. */
export interface UnknownInvoiceSummary {
  readonly id: string;
  readonly companyId: string;
  readonly environment: FiscalEnvironment;
  readonly dpsId: string;
  /** Envio da tentativa que ficou sem resposta (base da idade). */
  readonly since: Date;
  readonly attemptSeq: number;
  readonly lookups: number;
  readonly consecutiveLookupErrors: number;
  readonly openResolutionId: string | null;
}

/**
 * Leitura do operador (só metadados). Dado de empresa é lido SEMPRE no contexto da empresa (RLS);
 * a lista de empresas a olhar vem da fila, que só tem identificadores.
 */
export interface NfseDeskReader {
  /** Empresas com reconciliação de NFS-e pendente, em execução ou morta na fila. */
  companiesWithReconciliation(): Promise<readonly string[]>;
  listUnknown(companyId: string, sinceBefore: Date, limit: number): Promise<readonly UnknownInvoiceSummary[]>;
  findInvoice(companyId: string, id: string): Promise<{ readonly id: string; readonly companyId: string; readonly status: ServiceInvoiceStatus } | undefined>;
  findResolution(companyId: string, id: string): Promise<ServiceInvoiceResolution | undefined>;
}

/** Resultado da conferência do XML oficial da NFS-e trazido pelo operador. */
export type NfseVerification =
  | { readonly ok: true; readonly accessKey: string; readonly processedAt: Date; readonly dpsSignature: 'MATCH' | 'ABSENT' }
  /** `code` estável; nada do conteúdo do XML (pode ter dados pessoais). */
  | { readonly ok: false; readonly code: string };

export interface NfseDocumentVerifier {
  verify(
    nfseXml: string,
    expected: { readonly dpsId: string; readonly environment: FiscalEnvironment; readonly layoutPackage: string | null; readonly signedDps: string | undefined },
  ): Promise<NfseVerification>;
}

/** Tabela oficial de municípios do IBGE (ADR-0058): o código existe? */
export interface MunicipalityDirectory {
  exists(code: string): boolean;
}

/** Tabelas de referência do aceite (ADR-0058, ADR-0060): ANEXO_A do Sistema Nacional e IBGE. */
export interface FiscalReferenceTables {
  municipalityExists(code: string): boolean;
  countryExists(code: string): boolean;
}

/**
 * Gerador do DANFSe (ADR-0057; NT 008 SE/CGNFS-e v1.02): PDF a partir do XML autorizado. A marca
 * d'água vem da situação ATUAL da nota (CANCELADA, SUBSTITUÍDA), que o XML autorizado não traz.
 */
export interface DanfseRenderer {
  render(input: {
    readonly nfseXml: string;
    readonly accessKey: string;
    readonly situation: 'AUTHORIZED' | 'CANCELLED' | 'SUBSTITUTED';
  }): Promise<{ readonly ok: true; readonly pdf: Uint8Array } | { readonly ok: false; readonly code: string }>;
}

/** Destino dos alertas de UNKNOWN por idade (log estruturado no worker; só identificadores). */
export interface UnknownAlertSink {
  raise(alert: {
    readonly level: EscalationLevel;
    readonly companyId: string;
    readonly invoiceId: string;
    readonly environment: FiscalEnvironment;
    readonly ageSeconds: number;
    readonly attemptSeq: number;
    readonly lookups: number;
  }): void;
}

export interface NfseApiRepositories {
  readonly invoices: ServiceInvoiceRepository;
  readonly cancellations: CancellationRequestRepository;
  readonly establishments: EstablishmentReader;
  readonly series: SeriesAllocator;
  readonly production: ProductionGate;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
}

export interface NfseWorkerRepositories {
  readonly invoices: ServiceInvoiceWorkerRepository;
  readonly attempts: AttemptRepository;
  readonly resolutions: ResolutionRepository;
  readonly cancellations: CancellationRepository;
  readonly archiveChecks: ArchivedXmlCheckRepository;
  readonly production: ProductionGate;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
  readonly events: EventOutbox;
}

// ------------------------------------------------------------------ autorizador e preparação

/** Material do certificado do estabelecimento, só dentro de `withCredential` (worker-fiscal). */
export interface IssuerCredential {
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
}

export interface CredentialAccess {
  /** Lança `BusinessRuleError` (CERTIFICATE_NOT_AVAILABLE, CERTIFICATE_EXPIRED) antes de qualquer envio. */
  withCredential<T>(companyId: string, establishmentId: string, work: (credential: IssuerCredential) => Promise<T>): Promise<T>;
}

export interface GatewayContext {
  readonly environment: FiscalEnvironment;
  /** Canal gravado na nota no aceite (ADR-0028); escolhe o autorizador (ADR-0039). */
  readonly channel: string;
  readonly credential: IssuerCredential;
}

/** Um erro de rejeição como o autorizador devolveu (código do Anexo I e descrição), ADR-0059. */
export interface RejectionError {
  readonly code: string;
  readonly message: string;
}

/** Resultado do envio (ADR-0029). Timeout, reset, 5xx e resposta ilegível são sempre UNKNOWN. */
export type SubmissionOutcome =
  | { readonly kind: 'AUTHORIZED'; readonly accessKey: string; readonly nfseXml: string }
  /** `code` é o primeiro erro; `errors`, todos, na ordem do autorizador (ADR-0059). */
  | { readonly kind: 'REJECTED'; readonly code: string; readonly message: string; readonly errors?: readonly RejectionError[] }
  /** O autorizador já tem esta DPS (ex.: E0014): não é rejeição, leva à reconciliação imediata. */
  | { readonly kind: 'ALREADY_EXISTS' }
  /** Provado que nada saiu (fase connect). */
  | { readonly kind: 'NOT_SENT'; readonly errorCode: string }
  | { readonly kind: 'UNKNOWN'; readonly errorCode: string };

export type LookupOutcome =
  | { readonly kind: 'FOUND'; readonly accessKey: string; readonly nfseXml: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ERROR'; readonly errorCode: string };

/** Resultado do registro de evento. Mesma regra: sem prova de não envio, é UNKNOWN. */
export type EventOutcome =
  | { readonly kind: 'REGISTERED'; readonly eventXml: string }
  /** `code` é o primeiro erro; `errors`, todos, na ordem do autorizador (ADR-0059). */
  | { readonly kind: 'REJECTED'; readonly code: string; readonly message: string; readonly errors?: readonly RejectionError[] }
  /** O autorizador já tem este evento para a nota: leva à consulta imediata. */
  | { readonly kind: 'ALREADY_EXISTS' }
  | { readonly kind: 'NOT_SENT'; readonly errorCode: string }
  | { readonly kind: 'UNKNOWN'; readonly errorCode: string };

export type EventLookupOutcome =
  | { readonly kind: 'FOUND'; readonly eventXml: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ERROR'; readonly errorCode: string };

export interface NfseGateway {
  submit(signedDps: string, context: GatewayContext): Promise<SubmissionOutcome>;
  findByDpsId(dpsId: string, context: GatewayContext): Promise<LookupOutcome>;
  /** Pedido de registro de evento assinado (`pedRegEvento`) para a nota `accessKey`. */
  registerEvent(accessKey: string, signedEvent: string, context: GatewayContext): Promise<EventOutcome>;
  /**
   * Consulta o evento `eventType` de número sequencial `sequence` (`nSeqEvento`) da nota. A SEFIN
   * exige o número na rota (`GET /nfse/{chave}/eventos/{tipo}/{seq}`, Swagger de 2026-11-13).
   */
  findEvent(accessKey: string, eventType: string, sequence: number, context: GatewayContext): Promise<EventLookupOutcome>;
}

/** Monta o pedido de cancelamento, assina e valida no XSD (`pedRegEvento_v1.01.xsd`). */
export interface CancellationPreparer {
  prepare(cancellation: ServiceInvoiceCancellation, invoice: ServiceInvoice, credential: IssuerCredential): Promise<PreparationResult>;
}

export type PreparationResult =
  | { readonly ok: true; readonly signedXml: string; readonly layoutPackage: string }
  /** Falha local (L3/L4): nada foi transmitido → FAILED. `code` é estável; nada do conteúdo. */
  | { readonly ok: false; readonly code: string };

/** Monta a DPS a partir do documento aceito, valida no XSD (L4) e assina. */
export interface DpsPreparer {
  prepare(invoice: ServiceInvoice, credential: IssuerCredential): Promise<PreparationResult>;
}

/**
 * Pré-validação estrutural no aceite (XSD do ambiente, identificadores provisórios). Devolve as
 * mensagens do validador; vazio = válido. A validação que vale é a do worker (L4 com a DPS real).
 */
export interface DpsValidator {
  validate(environment: FiscalEnvironment, dps: DpsData): Promise<readonly string[]>;
}
