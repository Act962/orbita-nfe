/** Tipos de domínio da trilha de auditoria (porta em shared/application/audit.ts). */

export type AuditActor =
  | { readonly kind: 'CLIENT_APPLICATION'; readonly clientApplicationId: string; readonly credentialRef: string }
  | { readonly kind: 'OPERATOR'; readonly operator: string }
  | { readonly kind: 'SYSTEM'; readonly process: string };

/**
 * Detalhes do evento: só valores escalares (ou listas de texto), para o hash ser
 * determinístico. Nunca segredos: chaves com nome sensível são recusadas na gravação.
 */
export type AuditValue = string | number | boolean | null | readonly string[];
export type AuditDetails = Readonly<Record<string, AuditValue>>;

