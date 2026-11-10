import type { AuditActor, AuditDetails, AuditValue } from '../../../shared/domain/audit.js';

/**
 * Registro da trilha de auditoria encadeada (docs/architecture/14 §A4):
 * `hash = SHA-256(prev_hash ‖ payload canônico)`, uma cadeia por empresa e uma da plataforma.
 * Alterar, remover ou reordenar qualquer registro muda todos os hashes seguintes.
 */
export interface AuditEntry {
  /** null = cadeia da plataforma (operador). */
  readonly companyId: string | null;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly action: string;
  readonly actor: AuditActor;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly correlationId: string | null;
  readonly details: AuditDetails;
}

/** Versão do formato do payload. Mudar o formato exige nova versão, nunca reescrever a antiga. */
export const AUDIT_PAYLOAD_VERSION = 1;

/** Hash anterior ao primeiro registro de uma cadeia. */
export const GENESIS_HASH_HEX = '0'.repeat(64);

export interface ActorColumns {
  readonly actorKind: AuditActor['kind'];
  readonly actorId: string;
  readonly credentialRef: string | null;
}

export function actorColumns(actor: AuditActor): ActorColumns {
  switch (actor.kind) {
    case 'CLIENT_APPLICATION':
      return { actorKind: actor.kind, actorId: actor.clientApplicationId, credentialRef: actor.credentialRef };
    case 'OPERATOR':
      return { actorKind: actor.kind, actorId: actor.operator, credentialRef: null };
    case 'SYSTEM':
      return { actorKind: actor.kind, actorId: actor.process, credentialRef: null };
  }
}

export function actorFromColumns(columns: ActorColumns): AuditActor {
  switch (columns.actorKind) {
    case 'CLIENT_APPLICATION':
      return { kind: 'CLIENT_APPLICATION', clientApplicationId: columns.actorId, credentialRef: columns.credentialRef ?? '' };
    case 'OPERATOR':
      return { kind: 'OPERATOR', operator: columns.actorId };
    case 'SYSTEM':
      return { kind: 'SYSTEM', process: columns.actorId };
  }
}

type Canonical = AuditValue | { readonly [key: string]: Canonical } | readonly Canonical[];

/**
 * JSON canônico: chaves em ordem lexicográfica (por code unit), sem espaços, só os tipos do
 * payload. Números só inteiros seguros (decimais teriam representação ambígua).
 */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('auditoria aceita apenas números inteiros seguros');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: Canonical) => canonicalJson(item)).join(',')}]`;
  const record = value as { readonly [key: string]: Canonical };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as Canonical)}`).join(',')}}`;
}

/** Conteúdo hasheado do registro (inclui empresa e sequência: um registro não pode ser movido). */
export function entryPayload(entry: AuditEntry): string {
  const actor = actorColumns(entry.actor);
  return canonicalJson({
    v: AUDIT_PAYLOAD_VERSION,
    companyId: entry.companyId,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt.toISOString(),
    action: entry.action,
    actorKind: actor.actorKind,
    actorId: actor.actorId,
    credentialRef: actor.credentialRef,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    correlationId: entry.correlationId,
    details: entry.details,
  });
}

/** Valida os detalhes: escalares ou listas de texto, sem nomes sensíveis (decidido por `isSensitiveKey`). */
export function invalidDetailKeys(details: AuditDetails, isSensitiveKey: (key: string) => boolean): string[] {
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    const scalarOk = value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isSafeInteger(value));
    const listOk = Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (isSensitiveKey(key) || !(scalarOk || listOk)) invalid.push(key);
  }
  return invalid;
}
