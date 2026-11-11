import { clientApplicationOf, type AuditContext, type AuditTrail } from '../../../shared/application/audit.js';
import { BusinessRuleError, InternalError, NotFoundError, ValidationFailedError } from '../../../shared/application/errors.js';
import type { JobScheduler } from '../../../shared/application/job-queue.js';
import { runDay } from '../../../shared/domain/daily-schedule.js';
import type { IdGenerator, TransactionOptions, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { newEstablishment, newCompany, type Establishment, type NewEstablishment, type NewCompany, type Company } from '../domain/company.js';

export interface CompanyRepository {
  /** Insere na empresa do contexto da transação. Conflito de raiz → COMPANY_ALREADY_REGISTERED. */
  insert(company: NewCompany): Promise<Company>;
  /** A empresa do contexto (RLS): só existe uma visível por transação. */
  current(): Promise<Company | undefined>;
}

export interface EstablishmentRepository {
  /** Conflito de CNPJ → ESTABLISHMENT_ALREADY_REGISTERED. */
  insert(establishment: NewEstablishment): Promise<Establishment>;
  findById(id: string): Promise<Establishment | undefined>;
  list(): Promise<Establishment[]>;
}

/** Porta para o IAM: concede ao criador acesso à empresa nova, na mesma transação. */
export interface AccessGrants {
  grant(companyId: string, clientApplicationId: string): Promise<void>;
}

export interface CompanyRepositories {
  readonly companies: CompanyRepository;
  readonly establishments: EstablishmentRepository;
  readonly accessGrants: AccessGrants;
  readonly audit: AuditTrail;
  /** Agenda a primeira âncora da cadeia de auditoria da empresa (ADR-0031). */
  readonly jobs: JobScheduler;
}

export const establishmentNotFound = (): NotFoundError => new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.');

/** Casos de uso do cadastro de contribuintes. Toda operação ocorre no contexto de uma empresa (RLS). */
export class CompanyService {
  constructor(
    private readonly uow: UnitOfWork<CompanyRepositories>,
    private readonly newId: IdGenerator,
  ) {}

  /**
   * Cria a empresa e concede a quem a criou o acesso a ela, atomicamente. O id é gerado aqui:
   * o cliente nunca escolhe o identificador da empresa.
   */
  async registerCompany(input: { legalName: string; rootCnpj: string }, context: AuditContext, options: TransactionOptions = {}): Promise<Company> {
    const createdBy = clientApplicationOf(context);
    if (createdBy === undefined) throw new InternalError('COMPANY_CREATOR_NOT_CLIENT_APPLICATION');
    const draft = newCompany({ id: this.newId(), ...input });
    if (!draft.ok) throw new ValidationFailedError(draft.error);
    return this.uow.inCompany(draft.value.id, async (r) => {
      const company = await r.companies.insert(draft.value);
      await r.accessGrants.grant(company.id, createdBy);
      await r.audit.record(context, {
        action: 'company.registered',
        subject: { type: 'company', id: company.id },
        details: { rootCnpj: company.rootCnpj, legalName: company.legalName },
      });
      await r.audit.record(context, { action: 'company_grant.granted', subject: { type: 'client_application', id: createdBy } });
      // A cadeia da empresa nasce aqui: a âncora diária começa já, e cada execução agenda a seguinte.
      await r.jobs.enqueue({
        queue: 'audit.anchor-company',
        payload: { companyId: company.id },
        singletonKey: `${company.id}:${runDay(new Date())}`,
        correlationId: context.correlationId,
      });
      return company;
    }, options);
  }

  async currentCompany(companyId: string): Promise<Company> {
    return this.uow.inCompany(companyId, async (r) => {
      const company = await r.companies.current();
      // A concessão já foi conferida com a empresa ativa: ausência aqui é inconsistência.
      if (company === undefined) throw new InternalError('COMPANY_CONTEXT_WITHOUT_COMPANY');
      return company;
    });
  }

  async registerEstablishment(
    companyId: string,
    input: { cnpj: string; tradeName: string; municipalityCode: string },
    context: AuditContext,
    options: TransactionOptions = {},
  ): Promise<Establishment> {
    return this.uow.inCompany(companyId, async (r) => {
      const company = await r.companies.current();
      if (company === undefined) throw new InternalError('COMPANY_CONTEXT_WITHOUT_COMPANY');
      const draft = newEstablishment(company, { id: this.newId(), ...input });
      if (!draft.ok) {
        if (draft.error.kind === 'INVALID') throw new ValidationFailedError(draft.error.issues);
        throw new BusinessRuleError(draft.error.issue.code, draft.error.issue.message, [draft.error.issue]);
      }
      const establishment = await r.establishments.insert(draft.value);
      await r.audit.record(context, {
        action: 'establishment.registered',
        subject: { type: 'establishment', id: establishment.id },
        details: { cnpj: establishment.cnpj, municipalityCode: establishment.municipalityCode },
      });
      return establishment;
    }, options);
  }

  async establishment(companyId: string, id: string): Promise<Establishment> {
    const found = await this.uow.inCompany(companyId, (r) => r.establishments.findById(id));
    if (found === undefined) throw establishmentNotFound();
    return found;
  }

  async establishments(companyId: string): Promise<Establishment[]> {
    return this.uow.inCompany(companyId, (r) => r.establishments.list());
  }
}
