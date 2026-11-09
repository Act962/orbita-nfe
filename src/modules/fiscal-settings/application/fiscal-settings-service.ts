import { BusinessRuleError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import {
  newDocumentSeries,
  type DocumentKind,
  type DocumentSeries,
  type FiscalEnvironment,
  type NewDocumentSeries,
  type NumberAllocation,
} from '../domain/document-series.js';

export interface DocumentSeriesRepository {
  /** Conflito de (estabelecimento, modalidade, ambiente, série) → DOCUMENT_SERIES_ALREADY_EXISTS. */
  insert(series: NewDocumentSeries): Promise<DocumentSeries>;
  listByEstablishment(establishmentId: string): Promise<DocumentSeries[]>;
  /**
   * Aloca o próximo número na transação corrente (ADR-0008). Se a transação for desfeita,
   * o número não é consumido. Concorrência serializada pela linha da série.
   */
  allocateNext(seriesId: string): Promise<NumberAllocation>;
}

/** Porta para o cadastro de estabelecimentos (módulo company), no mesmo contexto de empresa. */
export interface EstablishmentDirectory {
  exists(establishmentId: string): Promise<boolean>;
}

export interface FiscalSettingsRepositories {
  readonly series: DocumentSeriesRepository;
  readonly establishments: EstablishmentDirectory;
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
  ) {}

  async createSeries(
    companyId: string,
    establishmentId: string,
    input: { kind: DocumentKind; environment: FiscalEnvironment; series: string; nextNumber?: number | undefined },
  ): Promise<DocumentSeries> {
    const draft = newDocumentSeries({ id: this.newId(), companyId, establishmentId, ...input });
    if (!draft.ok) throw new ValidationFailedError(draft.error);
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      return r.series.insert(draft.value);
    });
  }

  async listSeries(companyId: string, establishmentId: string): Promise<DocumentSeries[]> {
    return this.uow.inCompany(companyId, async (r) => {
      if (!(await r.establishments.exists(establishmentId))) throw establishmentNotFound();
      return r.series.listByEstablishment(establishmentId);
    });
  }

  /** Alocação isolada (a emissão usará `allocateNext` dentro da própria transação de aceitação). */
  async allocateNumber(companyId: string, seriesId: string): Promise<number> {
    return this.uow.inCompany(companyId, async (r) => requireAllocated(await r.series.allocateNext(seriesId)));
  }
}
