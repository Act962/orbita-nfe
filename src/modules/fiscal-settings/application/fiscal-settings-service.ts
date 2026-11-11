import type { AuditContext, AuditTrail } from '../../../shared/application/audit.js';
import { BusinessRuleError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator, TransactionOptions, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import {
  newDocumentSeries,
  type DocumentKind,
  type DocumentSeries,
  type FiscalEnvironment,
  type NewDocumentSeries,
  type NumberAllocation,
} from '../domain/document-series.js';
import {
  checkEnablement,
  normalizeRevocationReason,
  type NewProductionEnablement,
  type ProductionEnablement,
} from '../domain/production-enablement.js';

export interface DocumentSeriesRepository {
  /** Conflito de (estabelecimento, modalidade, ambiente, série) → DOCUMENT_SERIES_ALREADY_EXISTS. */
  insert(series: NewDocumentSeries): Promise<DocumentSeries>;
  listByEstablishment(establishmentId: string): Promise<DocumentSeries[]>;
  /**
   * Aloca o próximo número na transação corrente (ADR-0008). Se a transação for desfeita,
   * o número não é consumido. Concorrência serializada pela linha da série.
   */
  allocateNext(seriesId: string): Promise<NumberAllocation>;
  /** Há série ACTIVE desta modalidade e ambiente no estabelecimento? */
  hasActive(establishmentId: string, kind: DocumentKind, environment: FiscalEnvironment): Promise<boolean>;
}

export interface ProductionEnablementRepository {
  /** Já há uma ACTIVE para (estabelecimento, modalidade) → PRODUCTION_ALREADY_ENABLED. */
  insert(enablement: NewProductionEnablement): Promise<ProductionEnablement>;
  listByEstablishment(establishmentId: string): Promise<ProductionEnablement[]>;
  /** Só ACTIVE → REVOKED; devolve undefined se não houver ACTIVE com este id no estabelecimento. */
  revoke(establishmentId: string, id: string, reason: string): Promise<ProductionEnablement | undefined>;
  /** Trava do pré-envio (L5, Fase 2a): a modalidade está habilitada para produção? */
  isEnabled(establishmentId: string, kind: DocumentKind): Promise<boolean>;
}

/** Porta para o cadastro de estabelecimentos (módulo company), no mesmo contexto de empresa. */
export interface EstablishmentDirectory {
  exists(establishmentId: string): Promise<boolean>;
}

/** Porta para o cadastro (módulo company): dados do estabelecimento usados na habilitação. */
export interface EstablishmentProfiles {
  profile(establishmentId: string): Promise<{ cnpj: string; status: 'ACTIVE' | 'INACTIVE' } | undefined>;
}

/** Porta para o Certificate Vault: só a pergunta, nunca o material. */
export interface CertificateAvailability {
  hasUsableCertificate(establishmentId: string, at: Date): Promise<boolean>;
}

export interface FiscalSettingsRepositories {
  readonly series: DocumentSeriesRepository;
  readonly enablements: ProductionEnablementRepository;
  readonly establishments: EstablishmentDirectory & EstablishmentProfiles;
  readonly certificates: CertificateAvailability;
  readonly audit: AuditTrail;
}

const establishmentNotFound = (): NotFoundError => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.');

/** Converte o resultado da alocação em erro de aplicação quando não houve número. */
export function requireAllocated(allocation: NumberAllocation): number {
  switch (allocation.kind) {
    case 'ALLOCATED':
      return allocation.number;
    case 'NOT_FOUND':
      throw new NotFoundError('DOCUMENT_SERIES_NOT_FOUND', 'Série não encontrada.');
    case 'INACTIVE':
      throw new BusinessRuleError('DOCUMENT_SERIES_INACTIVE', 'A série está inativa.');
    case 'EXHAUSTED':
      throw new BusinessRuleError('DOCUMENT_SERIES_EXHAUSTED', 'A série atingiu o último número permitido pela modalidade.');
  }
}

export class FiscalSettingsService {
  constructor(
    private readonly uow: UnitOfWork<FiscalSettingsRepositories>,
    private readonly newId: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createSeries(
    companyId: string,
    establishmentId: string,
    input: { kind: DocumentKind; environment: FiscalEnvironment; series: string; nextNumber?: number | undefined },
    context: AuditContext,
    options: TransactionOptions = {},
  ): Promise<DocumentSeries> {
    const draft = newDocumentSeries({ id: this.newId(), companyId, establishmentId, ...input });
    if (!draft.ok) throw new ValidationFailedError(draft.error);
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      const series = await r.series.insert(draft.value);
      await r.audit.record(context, {
        action: 'document_series.created',
        subject: { type: 'document_series', id: series.id },
        details: { establishmentId, kind: series.kind, environment: series.environment, series: series.series, nextNumber: series.nextNumber },
      });
      return series;
    }, options);
  }

  async listSeries(companyId: string, establishmentId: string): Promise<DocumentSeries[]> {
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      return r.series.listByEstablishment(establishmentId);
    });
  }

  /**
   * Habilita a modalidade para produção no estabelecimento (ADR-0027). Exige credencial `live`
   * (conferida na rota) e os pré-requisitos de cadastro da regra PROD-001.
   */
  async enableProduction(
    companyId: string,
    establishmentId: string,
    input: { kind: DocumentKind; confirmCnpj: string },
    context: AuditContext,
    options: TransactionOptions = {},
  ): Promise<ProductionEnablement> {
    return this.uow.inCompany(
      companyId,
      async (r) => {
        const establishment = await r.establishments.profile(establishmentId);
        if (establishment === undefined) throw establishmentNotFound();
        const issues = checkEnablement(
          {
            establishment,
            hasUsableCertificate: await r.certificates.hasUsableCertificate(establishmentId, this.now()),
            hasActiveProductionSeries: await r.series.hasActive(establishmentId, input.kind, 'PRODUCTION'),
          },
          input.confirmCnpj,
        );
        if (issues.length > 0) {
          throw new BusinessRuleError('PRODUCTION_PREREQUISITES_NOT_MET', 'O estabelecimento ainda não pode ser habilitado para produção.', issues);
        }
        const enablement = await r.enablements.insert({ id: this.newId(), companyId, establishmentId, kind: input.kind });
        await r.audit.record(context, {
          action: 'production_enablement.granted',
          subject: { type: 'production_enablement', id: enablement.id },
          details: { establishmentId, kind: enablement.kind },
        });
        return enablement;
      },
      options,
    );
  }

  async revokeProduction(
    companyId: string,
    establishmentId: string,
    enablementId: string,
    input: { reason: string },
    context: AuditContext,
  ): Promise<ProductionEnablement> {
    const reason = normalizeRevocationReason(input.reason);
    if (!reason.ok) throw new ValidationFailedError([reason.issue]);
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      const revoked = await r.enablements.revoke(establishmentId, enablementId, reason.value);
      if (revoked === undefined) throw new NotFoundError('PRODUCTION_ENABLEMENT_NOT_FOUND', 'Habilitação ativa não encontrada.');
      await r.audit.record(context, {
        action: 'production_enablement.revoked',
        subject: { type: 'production_enablement', id: revoked.id },
        details: { establishmentId, kind: revoked.kind },
      });
      return revoked;
    });
  }

  async listProductionEnablements(companyId: string, establishmentId: string): Promise<ProductionEnablement[]> {
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      return r.enablements.listByEstablishment(establishmentId);
    });
  }

  /** Alocação isolada (a emissão usará `allocateNext` dentro da própria transação de aceitação). */
  async allocateNumber(companyId: string, seriesId: string): Promise<number> {
    return this.uow.inCompany(companyId, async (r) => requireAllocated(await r.series.allocateNext(seriesId)));
  }
}
