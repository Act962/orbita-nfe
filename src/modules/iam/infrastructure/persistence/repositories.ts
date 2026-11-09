import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { ConflictError } from '../../../../shared/application/errors.js';
import { withDatabaseErrors } from '../../../../shared/infrastructure/database/database-errors.js';
import type { Database, CompanyTransactions, Transaction } from '../../../../shared/infrastructure/database/database.js';
import type { CredentialEnvironment } from '../../domain/api-key-token.js';
import type {
  ActiveCredential,
  CredentialLookup,
  IamAdminStore,
  NewCredential,
  CompanyAccess,
  CompanyAccessLookup,
  CompanyGrantWriter,
} from '../../application/ports.js';
import { clientApplications, credentials, companyGrants } from './schema.js';

/** Leitura da credencial para autenticação (papel fiscal_api: só SELECT). */
export class DrizzleCredentialLookup implements CredentialLookup {
  constructor(private readonly db: Database) {}

  async findActiveByKeyId(keyId: string): Promise<ActiveCredential | undefined> {
    const rows = await withDatabaseErrors(() =>
      this.db
        .select({
          id: credentials.id,
          clientApplicationId: credentials.clientApplicationId,
          environment: credentials.environment,
          secretHash: credentials.secretHash,
          scopes: credentials.scopes,
        })
        .from(credentials)
        .innerJoin(clientApplications, eq(clientApplications.id, credentials.clientApplicationId))
        .where(
          and(
            eq(credentials.keyId, keyId),
            eq(credentials.status, 'ACTIVE'),
            eq(clientApplications.status, 'ACTIVE'),
            or(isNull(credentials.expiresAt), gt(credentials.expiresAt, sql`now()`)),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { ...row, environment: row.environment as CredentialEnvironment };
  }
}

/** Concessão lida no contexto da empresa (RLS em company_grants e companies). Sem cache. */
export class DrizzleCompanyAccessLookup implements CompanyAccessLookup {
  constructor(private readonly transactions: CompanyTransactions) {}

  async accessOf(clientApplicationId: string, companyId: string): Promise<CompanyAccess> {
    const rows = await this.transactions.run(companyId, (tx) =>
      tx.execute<{ grant_status: string; company_status: string }>(sql`
        select g.status as grant_status, t.status as company_status
          from company_grants g
          join companies t on t.id = g.company_id
         where g.client_application_id = ${clientApplicationId}
           and g.company_id = app_current_company()`),
    );
    const row = rows.rows[0];
    if (row?.grant_status !== 'ACTIVE') return 'NO_GRANT';
    return row.company_status === 'ACTIVE' ? 'GRANTED' : 'COMPANY_SUSPENDED';
  }
}

/** Concessão criada junto com a empresa, na mesma transação (módulo company). */
export function companyGrantWriter(tx: Transaction): CompanyGrantWriter {
  return {
    async grant(companyId, clientApplicationId) {
      await tx
        .insert(companyGrants)
        .values({ companyId, clientApplicationId, status: 'ACTIVE' })
        .onConflictDoUpdate({ target: [companyGrants.companyId, companyGrants.clientApplicationId], set: { status: 'ACTIVE', updatedAt: sql`now()` } });
    },
  };
}

/** Operações do operador. Conexão do papel fiscal_admin (nunca a da API). */
export class DrizzleIamAdminStore implements IamAdminStore {
  constructor(
    private readonly db: Database,
    private readonly transactions: CompanyTransactions,
  ) {}

  async createClientApplication(id: string, name: string): Promise<void> {
    await withDatabaseErrors(() => this.db.insert(clientApplications).values({ id, name }), {
      uq_client_applications_name: () => new ConflictError('CLIENT_APPLICATION_ALREADY_EXISTS', 'Já existe uma aplicação cliente com este nome.'),
    });
  }

  async clientApplicationExists(id: string): Promise<boolean> {
    const rows = await withDatabaseErrors(() =>
      this.db.select({ id: clientApplications.id }).from(clientApplications).where(eq(clientApplications.id, id)).limit(1),
    );
    return rows.length > 0;
  }

  async insertCredential(credential: NewCredential): Promise<void> {
    await withDatabaseErrors(() =>
      this.db.insert(credentials).values({
        id: credential.id,
        clientApplicationId: credential.clientApplicationId,
        keyId: credential.keyId,
        secretHash: Buffer.from(credential.secretHash),
        environment: credential.environment,
        scopes: [...credential.scopes],
        expiresAt: credential.expiresAt ?? null,
      }),
    );
  }

  async revokeCredential(keyId: string): Promise<boolean> {
    const rows = await withDatabaseErrors(() =>
      this.db
        .update(credentials)
        .set({ status: 'REVOKED', revokedAt: sql`now()` })
        .where(and(eq(credentials.keyId, keyId), eq(credentials.status, 'ACTIVE')))
        .returning({ id: credentials.id }),
    );
    return rows.length > 0;
  }

  async grantCompany(clientApplicationId: string, companyId: string): Promise<boolean> {
    return this.transactions.run(companyId, async (tx) => {
      const company = await tx.execute(sql`select 1 from companies where id = app_current_company()`);
      if (company.rows.length === 0) return false;
      await companyGrantWriter(tx).grant(companyId, clientApplicationId);
      return true;
    });
  }

  async revokeCompanyGrant(clientApplicationId: string, companyId: string): Promise<boolean> {
    return this.transactions.run(companyId, async (tx) => {
      const rows = await tx
        .update(companyGrants)
        .set({ status: 'REVOKED', updatedAt: sql`now()` })
        .where(and(eq(companyGrants.companyId, companyId), eq(companyGrants.clientApplicationId, clientApplicationId), eq(companyGrants.status, 'ACTIVE')))
        .returning({ companyId: companyGrants.companyId });
      return rows.length > 0;
    });
  }
}
