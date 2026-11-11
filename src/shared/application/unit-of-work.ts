/**
 * Porta de transação no contexto de uma empresa (docs/architecture/08 §1, ADR-0011).
 * Tudo o que `work` fizer com os repositories `R` acontece numa única transação, com o
 * empresa definida no banco (RLS). Erros saem sempre como ApplicationError.
 */
export interface UnitOfWork<R> {
  inCompany<T>(companyId: string, work: (repositories: R) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export interface TransactionOptions {
  /**
   * Ensaio (`dryRun`, ADR-0026): roda tudo, inclusive restrições do banco, triggers e
   * auditoria, e DESFAZ a transação no fim. Nada é gravado, nenhum job ou evento sai.
   */
  readonly dryRun?: boolean;
}

/** Gerador de identificadores (UUID v7 na infraestrutura). */
export type IdGenerator = () => string;
