import type { AuditTrail } from '../../../shared/application/audit.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import type { ConsumerSale } from '../domain/consumer-sale.js';
import type { ConsumerInvoiceStatus } from '../domain/consumer-invoice.js';

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

export interface NfceApiRepositories {
  readonly invoices: ConsumerInvoiceRepository;
  readonly issuers: NfceIssuerReader;
  readonly series: NfceSeriesAllocator;
  readonly production: NfceProductionGate;
  readonly audit: AuditTrail;
  readonly jobs: JobScheduler;
}
