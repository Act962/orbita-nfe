import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import pg from 'pg';
import type { ReadinessCheck } from '../../application/readiness.js';
import type { TransactionOptions } from '../../application/unit-of-work.js';
import { withDatabaseErrors, type ConstraintErrorMap } from './database-errors.js';

export type Database = NodePgDatabase;
export type Transaction = NodePgTransaction<Record<string, never>, ExtractTablesWithRelations<Record<string, never>>>;

export interface DatabaseOptions {
  readonly url: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax,
    application_name: options.applicationName,
    // Proteção contra queries presas: o banco cancela (SQLSTATE 57014 → DATABASE_TIMEOUT).
    statement_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs * 2,
    connectionTimeoutMillis: 5000,
  });
  // Erro em conexão ociosa do pool não pode derrubar o processo; vira indisponibilidade na próxima query.
  pool.on('error', () => undefined);
  const db = drizzle({ client: pool });
  return { db, pool, close: () => pool.end() };
}

/**
 * Transação no contexto de uma empresa (ADR-0011): `set_config('app.company_id', $1, true)` vale
 * só dentro da transação, então conexões devolvidas ao pool não carregam empresa.
 * Toda falha sai traduzida (database-errors.ts): nada de erro do Drizzle/pg para cima.
 */
export class CompanyTransactions {
  constructor(private readonly db: Database) {}

  async run<T>(companyId: string, work: (tx: Transaction) => Promise<T>, constraints: ConstraintErrorMap = {}, options: TransactionOptions = {}): Promise<T> {
    if (!UUID.test(companyId)) throw new Error('companyId inválido para contexto de transação');
    return withDatabaseErrors(async () => {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
          const result = await work(tx);
          // Ensaio: o resultado sai, a transação é desfeita (o PostgreSQL já validou tudo).
          if (options.dryRun === true) throw new DryRunRollback(result);
          return result;
        });
      } catch (error) {
        if (error instanceof DryRunRollback) return error.result as T;
        throw error;
      }
    }, constraints);
  }
}

/** Sinal interno do ensaio: desfaz a transação levando o resultado. Nunca sai deste arquivo. */
class DryRunRollback extends Error {
  constructor(readonly result: unknown) {
    super('dry run');
  }
}

export function databaseReadinessCheck(pool: pg.Pool): ReadinessCheck {
  return {
    name: 'postgres',
    async check() {
      await pool.query('select 1');
    },
  };
}
