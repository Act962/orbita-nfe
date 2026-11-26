import type { KeyObject } from 'node:crypto';
import type { AuditTrail } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { EventOutbox } from '../../../shared/application/outbox.js';
import type { ConsumerSale } from '../domain/consumer-sale.js';
import type { AttemptOutcome, AttemptState, ConsumerInvoiceStatus } from '../domain/consumer-invoice.js';

/** Portas da NFC-e (ADR-0072). Os módulos company e fiscal-settings as implementam no composition root. */
export type FiscalEnvironment = 'PRODUCTION' | 'HOMOLOGATION';

export interface ConsumerInvoice {
  readonly id: string;
  readonly companyId: string;
  readonly establishmentId: string;
  readonly clientApplicationId: string;
  readonly environment: FiscalEnvironment;
  readonly seriesId: string;
  readonly series: string;
  readonly number: number;
  /** cNF da chave (regra B03-10), sorteado no aceite. */
  readonly numericCode: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly externalReference: string | null;
  readonly sale: ConsumerSale;
  readonly status: ConsumerInvoiceStatus;
  readonly leaseUntil: Date | null;
  readonly accessKey: string | null;
  readonly protocolNumber: string | null;
  readonly authorizerStatusCode: string | null;
  readonly authorizedAt: Date | null;
  readonly rejectionCode: string | null;
  readonly rejectionMessage: string | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewConsumerInvoice = Pick<
  ConsumerInvoice,
  | 'id'
  | 'companyId'
  | 'establishmentId'
  | 'clientApplicationId'
  | 'environment'
  | 'seriesId'
  | 'series'
  | 'number'
  | 'numericCode'
  | 'idempotencyKey'
  | 'requestHash'
  | 'externalReference'
  | 'sale'
>;

export interface ConsumerInvoiceRepository {
  findById(id: string): Promise<ConsumerInvoice | undefined>;
  findByIdempotencyKey(clientApplicationId: string, key: string): Promise<ConsumerInvoice | undefined>;
  /** Nota com a referência ainda "ocupada" (não REJECTED/FAILED) no ambiente. */
  findActiveByExternalReference(clientApplicationId: string, environment: FiscalEnvironment, reference: string): Promise<ConsumerInvoice | undefined>;
  /** Todas as notas da referência no ambiente, da mais nova para a mais antiga, até `limit`. */
  listByExternalReference(clientApplicationId: string, environment: FiscalEnvironment, reference: string, limit: number): Promise<readonly ConsumerInvoice[]>;
  insert(invoice: NewConsumerInvoice): Promise<ConsumerInvoice>;
  /** `nfeProc` da nota autorizada e o SHA-256 gravado junto (ADR-0073). */
  storedXml(id: string): Promise<{ readonly xml: string | null; readonly sha256: string | null } | undefined>;
}

/** O emitente no aceite: só o que decide se a loja pode emitir NFC-e (ADR-0071). */
export interface NfceIssuer {
  readonly id: string;
  readonly cnpj: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  /** CRT do perfil estadual; nulo se a loja não tem perfil estadual. */
  readonly taxRegime: '1' | '2' | '3' | '4' | null;
}

export interface NfceIssuerReader {
  find(establishmentId: string): Promise<NfceIssuer | undefined>;
}

export interface NfceSeries {
  readonly id: string;
  readonly series: string;
}

export interface NfceSeriesAllocator {
  /** Séries ATIVAS de NFC-e do estabelecimento no ambiente. */
  activeSeries(establishmentId: string, environment: FiscalEnvironment): Promise<readonly NfceSeries[]>;
  /** Número na transação corrente (ADR-0008): rollback devolve o número. */
  allocate(seriesId: string): Promise<number>;
}

export interface NfceProductionGate {
  isEnabled(establishmentId: string): Promise<boolean>;
}

// ------------------------------------------------------------------ worker-fiscal (ADR-0072, fatia 3)

/** Tentativa de transmissão: o XML que ela montou e assinou, com a chave e o digest. */
export interface NfceAttempt {
  readonly id: string;
  readonly invoiceId: string;
  readonly seq: number;
  readonly state: AttemptState;
  readonly accessKey: string;
  readonly issuedAt: Date;
  readonly payloadSha256: string;
  readonly digestValue: string;
  readonly preparedAt: Date;
  readonly sendingAt: Date | null;
  readonly closedAt: Date | null;
  readonly outcome: AttemptOutcome | null;
  readonly outcomeCode: string | null;
  readonly lookups: number;
  readonly firstNotFoundAt: Date | null;
  readonly consecutiveLookupErrors: number;
}

export interface NfceAttemptRepository {
  open(invoiceId: string): Promise<NfceAttempt | undefined>;
  last(invoiceId: string): Promise<NfceAttempt | undefined>;
  /** O XML assinado de uma tentativa (o que saiu, ou pode ter saído). */
  signedXml(attemptId: string): Promise<string | undefined>;
  anySent(invoiceId: string): Promise<boolean>;
  insert(attempt: {
    readonly id: string;
    readonly companyId: string;
    readonly invoiceId: string;
    readonly seq: number;
    readonly accessKey: string;
    readonly issuedAt: Date;
    readonly signedXml: string;
    readonly payloadSha256: string;
    readonly digestValue: string;
  }): Promise<NfceAttempt>;
  markSending(attemptId: string, at: Date): Promise<void>;
  close(attemptId: string, outcome: AttemptOutcome, outcomeCode: string | null, at: Date): Promise<void>;
  recordLookup(attemptId: string, state: { readonly firstNotFoundAt: Date | null; readonly consecutiveLookupErrors: number }): Promise<void>;
}

/** O que o autorizador gravou (autorização ou denegação), na nota, uma única vez. */
export interface SettledByAuthorizer {
  readonly accessKey: string;
  readonly statusCode: string;
  readonly protocolNumber: string | null;
  readonly at: Date;
  /** `nfeProc` (NFe + protNFe), só na autorização. */
  readonly nfeProcXml?: string;
}

export interface ConsumerInvoiceStatusChange {
  readonly leaseUntil?: Date | null;
  readonly settled?: SettledByAuthorizer;
  readonly rejection?: { readonly code: string; readonly message: string };
  readonly failureCode?: string;
}

export interface ConsumerInvoiceWorkerRepository {
  findById(id: string): Promise<ConsumerInvoice | undefined>;
  /** Compare-and-set: muda o estado só se ainda for `from`. Devolve se mudou. */
  changeStatus(id: string, from: ConsumerInvoiceStatus, to: ConsumerInvoiceStatus, change?: ConsumerInvoiceStatusChange): Promise<boolean>;
  /** `nfeProc`, o hash gravado junto, a autorização e a situação do arquivamento (ADR-0074). */
  authorizedXml(id: string): Promise<
    { readonly xml: string | null; readonly sha256: string | null; readonly authorizedAt: Date | null; readonly objectKey: string | null } | undefined
  >;
  /** Grava o arquivamento uma única vez. Devolve se gravou (falso: já estava arquivado). */
  markArchived(id: string, archive: { readonly objectKey: string; readonly archivedAt: Date; readonly retainUntil: Date }): Promise<boolean>;
}

/**
 * Object storage dos artefatos fiscais com Object Lock (ADR-0010). `put` grava com retenção
 * COMPLIANCE e devolve os bytes relidos do bucket, para conferir o hash (mesma forma da NFS-e).
 */
export interface NfceArtifactStore {
  put(object: { readonly key: string; readonly body: Buffer; readonly contentType: string; readonly retainUntil: Date }): Promise<Buffer>;
  /** Lê o objeto e a trava, para a conferência periódica (ADR-0051, ADR-0075). */
  read(key: string): Promise<{ readonly body: Buffer; readonly lockMode: string | null; readonly retainUntil: Date | null } | undefined>;
}

/** O emitente completo na montagem (grupo `emit`): cadastro + tabela do IBGE (ADR-0071). */
export interface NfceEmitter {
  readonly cnpj: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly stateRegistration: string;
  readonly taxRegime: '1' | '2' | '3' | '4';
  readonly address: {
    readonly street: string;
    readonly number: string;
    readonly complement: string | null;
    readonly district: string;
    readonly municipalityCode: string;
    readonly municipalityName: string;
    readonly uf: string;
    readonly postalCode: string;
    readonly phone: string | null;
  };
}

export type EmitterLookup = { readonly ok: true; readonly emitter: NfceEmitter } | { readonly ok: false; readonly code: string };

export interface NfceEmitterReader {
  /** Falha com código estável (sem perfil estadual, município fora do IBGE) antes de qualquer envio. */
  emitter(companyId: string, establishmentId: string): Promise<EmitterLookup>;
}

/** Material do certificado do estabelecimento, só dentro de `withCredential` (worker-fiscal). */
export interface NfceCredential {
  readonly privateKey: KeyObject;
  readonly certificatePem: string;
}

export interface NfceCredentialAccess {
  /** Lança `BusinessRuleError` (CERTIFICATE_*) antes de qualquer envio. */
  withCredential<T>(companyId: string, establishmentId: string, work: (credential: NfceCredential) => Promise<T>): Promise<T>;
}

/** XML montado, assinado e validado no XSD para UMA tentativa (dhEmi = `issuedAt`). */
export type NfcePreparation =
  | { readonly ok: true; readonly signedXml: string; readonly accessKey: string; readonly digestValue: string }
  /** Falha local: nada foi transmitido. `code` é estável; nada do conteúdo. */
  | { readonly ok: false; readonly code: string };

export interface NfcePreparer {
  prepare(invoice: ConsumerInvoice, emitter: NfceEmitter, credential: NfceCredential, issuedAt: Date): Promise<NfcePreparation>;
}

export interface NfceGatewayContext {
  readonly environment: FiscalEnvironment;
  readonly credential: NfceCredential;
}

/** Resultado do envio (ADR-0070), já com o transporte classificado (ADR-0022). */
export type NfceSubmission =
  | { readonly kind: 'AUTHORIZED'; readonly statusCode: string; readonly protocolNumber: string; readonly authorizedAt: Date; readonly protocolXml: string }
  | { readonly kind: 'DENIED'; readonly statusCode: string; readonly protocolNumber: string | null }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly message: string }
  /** A chave ou o número já existem no autorizador: só a consulta diz o que houve. */
  | { readonly kind: 'ALREADY_EXISTS'; readonly code: string }
  /** Provado que nada saiu. */
  | { readonly kind: 'NOT_SENT'; readonly errorCode: string }
  /** Pode ter saído, ou a resposta não prova o resultado. */
  | { readonly kind: 'UNKNOWN'; readonly errorCode: string };

/** Situação pela chave (ADR-0064), conferida contra o digest da tentativa. */
export type NfceLookup =
  | { readonly kind: 'AUTHORIZED'; readonly statusCode: string; readonly protocolNumber: string; readonly authorizedAt: Date; readonly protocolXml: string }
  | { readonly kind: 'DENIED'; readonly statusCode: string; readonly protocolNumber: string | null }
  | { readonly kind: 'NOT_FOUND' }
  /** Consulta recusada, falha de transporte, ou nota com outro digest: não prova nada. */
  | { readonly kind: 'ERROR'; readonly errorCode: string };

export interface NfceAuthorizerGateway {
  submit(signedXml: string, expected: { readonly accessKey: string; readonly digestValue: string }, context: NfceGatewayContext): Promise<NfceSubmission>;
  lookup(expected: { readonly accessKey: string; readonly digestValue: string }, context: NfceGatewayContext): Promise<NfceLookup>;
}

export interface NfceWorkerRepositories {
  readonly invoices: ConsumerInvoiceWorkerRepository;
  readonly attempts: NfceAttemptRepository;
  readonly production: NfceProductionGate;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
  /** Webhook `consumer_invoice.status_changed`, na mesma transação da mudança (ADR-0073). */
  readonly events: EventOutbox;
}

export interface NfceApiRepositories {
  readonly invoices: ConsumerInvoiceRepository;
  readonly issuers: NfceIssuerReader;
  readonly series: NfceSeriesAllocator;
  readonly production: NfceProductionGate;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
}
