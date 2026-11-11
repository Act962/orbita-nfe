import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type {
  AuditContext,
  AuditDetails,
  AuditRecord,
  AuditTrail,
  PlatformAuditAction,
  PlatformAuditTrail,
} from '../../../../shared/application/audit.js';
import { COMPANY_AUDIT_ACTIONS, PLATFORM_AUDIT_ACTIONS } from '../../../../shared/application/audit.js';
import { InternalError } from '../../../../shared/application/errors.js';
import type { Database, Transaction } from '../../../../shared/infrastructure/database/database.js';
import { isSensitiveKey } from '../../../../shared/infrastructure/logging/sanitize.js';
import type { AuditChainHead, AuditChainReader, AuditChainRef, ChainHasher, StoredAuditEntry } from '../../application/audit-verifier.js';
import { actorColumns, actorFromColumns, entryPayload, invalidDetailKeys, type ActorColumns, type AuditEntry } from '../../domain/audit-entry.js';
import { auditChainHeads, auditLog, platformAuditHead, platformAuditLog } from './schema.js';

export const sha256ChainHasher: ChainHasher = {
  link(prevHashHex, payload) {
    return createHash('sha256').update(Buffer.from(prevHashHex, 'hex')).update(payload, 'utf8').digest('hex');
  },
};

type Executor = Pick<Transaction, 'execute' | 'insert'>;

interface HeadRow extends Record<string, unknown> {
  last_sequence: string;
  last_hash: string;
}

/** Trava a cabeça da cadeia (função SECURITY DEFINER da migration) até o fim da transação. */
async function lockHead(tx: Executor, fn: 'audit_lock_head' | 'platform_audit_lock_head'): Promise<{ sequence: number; hashHex: string }> {
  const result = await tx.execute<HeadRow>(sql.raw(`select last_sequence::text, encode(last_hash, 'hex') as last_hash from ${fn}()`));
  const row = result.rows[0];
  if (row === undefined) throw new InternalError('AUDIT_HEAD_UNAVAILABLE');
  return { sequence: Number(row.last_sequence), hashHex: row.last_hash };
}

function checkDetails(details: AuditDetails): void {
  const invalid = invalidDetailKeys(details, isSensitiveKey);
  // Erro de programação: o nome do campo vai no código, nunca o valor.
  if (invalid.length > 0) throw new InternalError('AUDIT_DETAILS_REJECTED');
}

interface Prepared {
  readonly row: ActorColumns & {
    sequence: number;
    occurredAt: Date;
    action: string;
    subjectType: string;
    subjectId: string;
    correlationId: string | null;
    details: Record<string, unknown>;
    prevHash: Buffer;
    hash: Buffer;
  };
}

function prepare(
  companyId: string | null,
  head: { sequence: number; hashHex: string },
  context: AuditContext,
  record: AuditRecord<string>,
  now: Date,
): Prepared {
  const details = record.details ?? {};
  checkDetails(details);
  const entry: AuditEntry = {
    companyId,
    sequence: head.sequence + 1,
    // O banco guarda milissegundos: o hash é calculado sobre o mesmo valor que será lido.
    occurredAt: new Date(Math.floor(now.getTime())),
    action: record.action,
    actor: context.actor,
    subjectType: record.subject.type,
    subjectId: record.subject.id,
    correlationId: context.correlationId,
    details,
  };
  const hashHex = sha256ChainHasher.link(head.hashHex, entryPayload(entry));
  return {
    row: {
      ...actorColumns(entry.actor),
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      correlationId: entry.correlationId,
      details: { ...details },
      prevHash: Buffer.from(head.hashHex, 'hex'),
      hash: Buffer.from(hashHex, 'hex'),
    },
  };
}

export interface AuditStoreOptions {
  readonly newId: () => string;
  readonly now?: () => Date;
}

/** Trilha da empresa do contexto, na transação `tx` (a mesma da mudança auditada). */
export function companyAuditTrail(tx: Executor, options: AuditStoreOptions): AuditTrail {
  const now = options.now ?? (() => new Date());
  return {
    async record(context, record) {
      if (!(COMPANY_AUDIT_ACTIONS as readonly string[]).includes(record.action)) throw new InternalError('AUDIT_ACTION_UNKNOWN');
      // company_id vem do contexto da transação (o RLS confere de novo na gravação).
      const companyRows = await tx.execute<{ id: string | null }>(sql`select app_current_company()::text as id`);
      const companyId = companyRows.rows[0]?.id;
      if (companyId === undefined || companyId === null) throw new InternalError('AUDIT_WITHOUT_COMPANY_CONTEXT');
      const head = await lockHead(tx, 'audit_lock_head');
      const { row } = prepare(companyId, head, context, record, now());
      await tx.insert(auditLog).values({ id: options.newId(), companyId, ...row });
    },
  };
}

/** Trilha da plataforma (operador), na transação `tx`. */
export function platformAuditTrail(tx: Executor, options: AuditStoreOptions): PlatformAuditTrail {
  const now = options.now ?? (() => new Date());
  return {
    async record(context, record: AuditRecord<PlatformAuditAction>) {
      if (!(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(record.action)) throw new InternalError('AUDIT_ACTION_UNKNOWN');
      if (context.actor.kind === 'CLIENT_APPLICATION') throw new InternalError('AUDIT_PLATFORM_ACTOR_INVALID');
      const head = await lockHead(tx, 'platform_audit_lock_head');
      const { row } = prepare(null, head, context, record, now());
      await tx.insert(platformAuditLog).values({ id: options.newId(), ...row });
    },
  };
}

type LogRow = typeof auditLog.$inferSelect | (typeof platformAuditLog.$inferSelect & { companyId?: undefined });

const toStored = (row: LogRow): StoredAuditEntry => ({
  companyId: row.companyId ?? null,
  sequence: row.sequence,
  occurredAt: row.occurredAt,
  action: row.action,
  actor: actorFromColumns({ actorKind: row.actorKind as ActorColumns['actorKind'], actorId: row.actorId, credentialRef: row.credentialRef }),
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  correlationId: row.correlationId,
  details: row.details as AuditDetails,
  prevHashHex: row.prevHash.toString('hex'),
  hashHex: row.hash.toString('hex'),
});

/**
 * Leitura das cadeias pelo papel do operador (fiscal_admin). A cadeia de empresa é lida no
 * contexto da empresa (RLS), via `inCompany`.
 */
export class DrizzleAuditChainReader implements AuditChainReader {
  constructor(
    private readonly db: Database,
    private readonly inCompany: <T>(companyId: string, work: (tx: Transaction) => Promise<T>) => Promise<T>,
  ) {}

  async page(chain: AuditChainRef, afterSequence: number, limit: number): Promise<StoredAuditEntry[]> {
    if (chain.kind === 'PLATFORM') {
      const rows = await this.db.select().from(platformAuditLog).where(gt(platformAuditLog.sequence, afterSequence)).orderBy(asc(platformAuditLog.sequence)).limit(limit);
      return rows.map(toStored);
    }
    return this.inCompany(chain.companyId, async (tx) => {
      const rows = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.companyId, chain.companyId), gt(auditLog.sequence, afterSequence)))
        .orderBy(asc(auditLog.sequence))
        .limit(limit);
      return rows.map(toStored);
    });
  }

  async head(chain: AuditChainRef): Promise<AuditChainHead | undefined> {
    if (chain.kind === 'PLATFORM') {
      const rows = await this.db.select().from(platformAuditHead).where(eq(platformAuditHead.id, 1)).limit(1);
      const row = rows[0];
      return row === undefined ? undefined : { sequence: row.lastSequence, hashHex: row.lastHash.toString('hex') };
    }
    return this.inCompany(chain.companyId, async (tx) => {
      const rows = await tx.select().from(auditChainHeads).where(eq(auditChainHeads.companyId, chain.companyId)).limit(1);
      const row = rows[0];
      return row === undefined ? undefined : { sequence: row.lastSequence, hashHex: row.lastHash.toString('hex') };
    });
  }
}

/**
 * Cabeças lidas pelo worker-general para a âncora (ADR-0031). Ele não tem privilégio nenhum nas
 * tabelas de auditoria: lê só (sequência, hash) pelas funções SECURITY DEFINER da migration 0011.
 * A cabeça da empresa vem da empresa do CONTEXTO da transação (RLS), nunca de um id informado.
 */
export function anchorHeadReader(
  db: Database,
  inCompany: <T>(companyId: string, work: (tx: Transaction) => Promise<T>) => Promise<T>,
): { head(chain: AuditChainRef): Promise<AuditChainHead | undefined> } {
  const toHead = (row: { last_sequence: string | number; last_hash: Buffer } | undefined): AuditChainHead | undefined =>
    row === undefined ? undefined : { sequence: Number(row.last_sequence), hashHex: row.last_hash.toString('hex') };
  return {
    async head(chain) {
      if (chain.kind === 'PLATFORM') {
        const rows = await db.execute<{ last_sequence: string; last_hash: Buffer }>(sql`select last_sequence, last_hash from audit_platform_head_for_anchor()`);
        return toHead(rows.rows[0]);
      }
      return inCompany(chain.companyId, async (tx) => {
        const rows = await tx.execute<{ last_sequence: string; last_hash: Buffer }>(sql`select last_sequence, last_hash from audit_company_head_for_anchor()`);
        return toHead(rows.rows[0]);
      });
    },
  };
}

