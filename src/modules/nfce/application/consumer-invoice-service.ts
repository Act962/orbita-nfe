import { createHash, randomInt } from 'node:crypto';
import { clientApplicationOf, type AuditContext } from '../../../shared/application/audit.js';
import { BusinessRuleError, ConflictError, ForbiddenError, InternalError, NotFoundError } from '../../../shared/application/errors.js';
import type { IdGenerator, UnitOfWork } from '../../../shared/application/unit-of-work.js';
import { isAcceptableNumericCode } from '../domain/access-key.js';
import { checkConsumerSale, type ConsumerSale } from '../domain/consumer-sale.js';
import type { ConsumerInvoice, FiscalEnvironment, NfceApiRepositories, NfceDanfeRenderer, NfceDiagnosticsData, NfceIssuer, NfceSeries } from './ports.js';

export interface AcceptConsumerInvoice {
  readonly companyId: string;
  readonly clientApplicationId: string;
  /** Vem da credencial (ADR-0026 item 3): `test` → homologação, `live` → produção. */
  readonly environment: FiscalEnvironment;
  readonly establishmentId: string;
  /** Opcional quando o estabelecimento tem uma única série de NFC-e ativa no ambiente. */
  readonly seriesId?: string | undefined;
  readonly idempotencyKey: string;
  /** SHA-256 do pedido normalizado (ADR-0007). */
  readonly requestHash: string;
  /** Contrato v1 (ADR-0069), já conferido na forma pela apresentação. */
  readonly sale: ConsumerSale;
}

/** O que a validação sem emitir precisa: o aceite sem a idempotência (ADR-0077). */
export type ValidateConsumerInvoice = Omit<AcceptConsumerInvoice, 'idempotencyKey' | 'requestHash'>;

/** XML pronto para download: os bytes, o SHA-256 conferido e o nome sugerido. */
export interface NfceXmlDownload {
  readonly xml: string;
  readonly sha256: string;
  readonly fileName: string;
}

export interface AcceptResult {
  readonly invoice: ConsumerInvoice;
  /** Repetição da mesma requisição: a nota já aceita, sem criar outra. */
  readonly replayed: boolean;
}

/** Código interno da corrida perdida na chave de idempotência (constraint → releitura). */
export const NFCE_IDEMPOTENCY_RACE = 'CONSUMER_INVOICE_IDEMPOTENCY_RACE';
export const NFCE_REFERENCE_LIST_LIMIT = 50;

/** Sorteio do cNF: 8 dígitos (regra B03-10). Injetável para os testes. */
export type NumericCodeSource = () => string;
export const randomNumericCode: NumericCodeSource = () => String(randomInt(0, 100_000_000)).padStart(8, '0');

/**
 * Aceite da NFC-e na API (ADR-0072, fatia 2). Numa transação: idempotência, referência externa,
 * emitente com perfil estadual, regras da venda (ADR-0069), habilitação de produção, série, número
 * (ADR-0008), cNF, PENDING, auditoria e job `nfce.process`. Nada é montado nem assinado aqui: o
 * XML nasce no worker, a cada tentativa (regra B09-40).
 *
 * Repetir a requisição nunca gera outra nota (ADR-0007): a chave é conferida antes e, numa corrida,
 * a restrição UNIQUE decide e o perdedor relê a nota vencedora.
 */
export class ConsumerInvoiceService {
  constructor(
    private readonly uow: UnitOfWork<NfceApiRepositories>,
    private readonly newId: IdGenerator,
    private readonly numericCode: NumericCodeSource = randomNumericCode,
    /** Sem gerador, a rota do DANFE responde 404 NFCE_DANFE_NOT_AVAILABLE. */
    private readonly danfeRenderer?: NfceDanfeRenderer,
  ) {}

  /**
   * DANFE NFC-e em PDF (ADR-0076), gerado na hora do `nfeProc` autorizado, depois de conferir os bytes
   * contra o hash gravado (o mesmo caminho do XML). Só a nota AUTHORIZED tem DANFE.
   */
  async danfe(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<{ readonly pdf: Uint8Array; readonly fileName: string }> {
    const download = await this.authorizedXml(companyId, clientApplicationId, environment, id);
    if (this.danfeRenderer === undefined) throw new NotFoundError('NFCE_DANFE_NOT_AVAILABLE', 'O gerador do DANFE NFC-e não está configurado.');
    const rendered = await this.danfeRenderer.render(download.xml);
    if (!rendered.ok) throw new InternalError(rendered.code);
    return { pdf: rendered.pdf, fileName: download.fileName.replace(/-procNFe\.xml$/, '-danfe-nfce.pdf') };
  }

  async accept(input: AcceptConsumerInvoice, context: AuditContext): Promise<AcceptResult> {
    try {
      return await this.uow.inCompany(input.companyId, (r) => this.acceptIn(r, input, context));
    } catch (error) {
      if (!(error instanceof ConflictError && error.code === NFCE_IDEMPOTENCY_RACE)) throw error;
      const winner = await this.uow.inCompany(input.companyId, (r) => r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey));
      if (winner === undefined) throw new InternalError('IDEMPOTENCY_RACE_WITHOUT_WINNER');
      return replay(winner, input);
    }
  }

  /**
   * Validação sem emitir (ADR-0077): as mesmas conferências do aceite, na mesma ordem e com os mesmos
   * erros, sem numerar, gravar, auditar nem enfileirar. A transação só lê.
   */
  async validate(input: ValidateConsumerInvoice): Promise<{ readonly series: NfceSeries }> {
    const { series } = await this.uow.inCompany(input.companyId, (r) => this.check(r, input));
    return { series };
  }

  /** Nota de outra aplicação ou de outro ambiente é tratada como inexistente. */
  async get(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<ConsumerInvoice> {
    const found = await this.uow.inCompany(companyId, (r) => r.invoices.findById(id));
    if (found?.clientApplicationId !== clientApplicationId || found.environment !== environment) throw notFound();
    return found;
  }

  /**
   * XML da nota autorizada (`nfeProc`: NFe + protNFe), ADR-0073. Os bytes são conferidos contra o
   * SHA-256 gravado junto com eles antes de sair: se não baterem, nada sai. A mesma visibilidade do `get`.
   */
  async authorizedXml(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<NfceXmlDownload> {
    return this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(id);
      if (invoice?.clientApplicationId !== clientApplicationId || invoice.environment !== environment) throw notFound();
      const stored = await r.invoices.storedXml(id);
      if (stored?.xml == null || stored.sha256 === null || invoice.accessKey === null) {
        throw new NotFoundError('NFCE_XML_NOT_AVAILABLE', `A NFC-e não tem XML autorizado (a nota está em ${invoice.status}).`);
      }
      const sha256 = createHash('sha256').update(stored.xml, 'utf8').digest('hex');
      if (sha256 !== stored.sha256) throw new InternalError('NFCE_XML_HASH_MISMATCH');
      return { xml: stored.xml, sha256, fileName: `${invoice.accessKey}-procNFe.xml` };
    });
  }

  /**
   * Diagnóstico da NFC-e (ADR-0078, molde do ADR-0055): arquivamento e cada tentativa, com o código
   * do resultado e as consultas pela chave. Só metadados: nenhum XML, nenhum dado do consumidor.
   * A mesma visibilidade do `get`.
   */
  async diagnostics(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, id: string): Promise<{ readonly invoice: ConsumerInvoice } & NfceDiagnosticsData> {
    return this.uow.inCompany(companyId, async (r) => {
      const invoice = await r.invoices.findById(id);
      if (invoice?.clientApplicationId !== clientApplicationId || invoice.environment !== environment) throw notFound();
      return { invoice, ...(await r.invoices.diagnostics(id)) };
    });
  }

  /** Notas da referência externa no ambiente da credencial, da mais nova para a mais antiga. */
  async listByExternalReference(companyId: string, clientApplicationId: string, environment: FiscalEnvironment, reference: string): Promise<readonly ConsumerInvoice[]> {
    return this.uow.inCompany(companyId, (r) => r.invoices.listByExternalReference(clientApplicationId, environment, reference, NFCE_REFERENCE_LIST_LIMIT));
  }

  private async acceptIn(r: NfceApiRepositories, input: AcceptConsumerInvoice, context: AuditContext): Promise<AcceptResult> {
    const existing = await r.invoices.findByIdempotencyKey(input.clientApplicationId, input.idempotencyKey);
    if (existing !== undefined) return replay(existing, input);

    const { issuer, series } = await this.check(r, input);
    const number = await r.series.allocate(series.id);
    const invoice = await r.invoices.insert({
      id: this.newId(),
      companyId: input.companyId,
      establishmentId: issuer.id,
      clientApplicationId: input.clientApplicationId,
      environment: input.environment,
      seriesId: series.id,
      series: series.series,
      number,
      numericCode: this.drawNumericCode(number),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      externalReference: input.sale.externalReference ?? null,
      sale: input.sale,
    });
    await r.audit.record(context, {
      action: 'consumer_invoice.accepted',
      subject: { type: 'consumer_invoice', id: invoice.id },
      details: {
        establishmentId: invoice.establishmentId,
        environment: invoice.environment,
        series: invoice.series,
        number: invoice.number,
        clientApplicationId: clientApplicationOf(context) ?? null,
      },
    });
    await r.jobs.enqueue({ queue: 'nfce.process', payload: { companyId: invoice.companyId, invoiceId: invoice.id }, singletonKey: invoice.id, correlationId: context.correlationId });
    return { invoice, replayed: false };
  }

  /** Conferências antes de numerar, sem escrever nada. A ordem é a do NFS-e. */
  private async check(r: NfceApiRepositories, input: ValidateConsumerInvoice): Promise<{ readonly issuer: NfceIssuer; readonly series: NfceSeries }> {
    const reference = input.sale.externalReference;
    if (reference !== undefined) {
      const occupied = await r.invoices.findActiveByExternalReference(input.clientApplicationId, input.environment, reference);
      if (occupied !== undefined) {
        throw occupied.status === 'AUTHORIZED'
          ? new ConflictError('DOCUMENT_ALREADY_AUTHORIZED', `Já existe NFC-e autorizada com esta referência externa (${occupied.id}).`)
          : new ConflictError('DOCUMENT_IN_PROGRESS', `Já existe NFC-e em andamento com esta referência externa (${occupied.id}). Não reemita.`);
      }
    }

    const issuer = await r.issuers.find(input.establishmentId);
    if (issuer === undefined) throw new NotFoundError('ESTABLISHMENT_NOT_FOUND', 'Estabelecimento não encontrado.');
    if (issuer.status !== 'ACTIVE') throw new BusinessRuleError('ESTABLISHMENT_INACTIVE', 'O estabelecimento está inativo.');
    // ADR-0071: o emitente sai do cadastro. Sem perfil estadual, não há como montar o grupo emit.
    if (issuer.taxRegime === null) {
      throw new BusinessRuleError(
        'NFCE_STATE_PROFILE_REQUIRED',
        'O estabelecimento não tem perfil estadual (inscrição estadual, CRT e endereço). Cadastre-o em PUT /v1/establishments/{id}/state-profile.',
      );
    }

    const violations = checkConsumerSale(input.sale, { cnpj: issuer.cnpj, taxRegime: issuer.taxRegime });
    if (violations.length > 0) {
      throw new BusinessRuleError('NFCE_RULES_VIOLATED', 'A venda viola regras oficiais da NFC-e (ADR-0069); o autorizador a rejeitaria.', violations);
    }

    if (input.environment === 'PRODUCTION' && !(await r.production.isEnabled(issuer.id))) {
      throw new ForbiddenError('PRODUCTION_NOT_ENABLED', 'A NFC-e não está habilitada para produção neste estabelecimento (PROD-001).');
    }

    const candidates = await r.series.activeSeries(issuer.id, input.environment);
    const series = input.seriesId === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : candidates.find((s) => s.id === input.seriesId);
    if (series === undefined) {
      if (input.seriesId !== undefined || candidates.length === 0) {
        throw new BusinessRuleError('NFCE_SERIES_NOT_AVAILABLE', 'Não há série de NFC-e ativa (ou a informada não é ativa) para o estabelecimento neste ambiente.');
      }
      throw new BusinessRuleError('NFCE_SERIES_REQUIRED', 'O estabelecimento tem mais de uma série de NFC-e ativa neste ambiente: informe a série.');
    }
    return { issuer, series };
  }

  /** cNF aleatório que respeita a regra B03-10 (ADR-0065). Sorteio falho repetido é defeito, não acaso. */
  private drawNumericCode(number: number): string {
    for (let tries = 0; tries < 20; tries++) {
      const candidate = this.numericCode();
      if (/^[0-9]{8}$/.test(candidate) && isAcceptableNumericCode(candidate, number)) return candidate;
    }
    throw new InternalError('NFCE_NUMERIC_CODE_UNAVAILABLE');
  }
}

function replay(existing: ConsumerInvoice, input: Pick<AcceptConsumerInvoice, 'requestHash'>): AcceptResult {
  if (existing.requestHash !== input.requestHash) {
    throw new BusinessRuleError('IDEMPOTENCY_KEY_REUSED', 'Esta Idempotency-Key já foi usada com outro conteúdo. Use uma chave nova para uma nota nova.');
  }
  return { invoice: existing, replayed: true };
}

const notFound = () => new NotFoundError('CONSUMER_INVOICE_NOT_FOUND', 'NFC-e não encontrada.');
