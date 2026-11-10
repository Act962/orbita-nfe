/**
 * Catálogo fechado de escopos (ADR-0012, docs/architecture/02 §1).
 * Uma credencial só recebe escopos deste catálogo; uma rota só exige escopos deste catálogo
 * (verificado na inicialização da API).
 *
 * Convenção `<recurso>:<ação>`. `:manage` implica `:read` do mesmo recurso.
 */
export const SCOPES = [
  'companies:create',
  'companies:read',
  'companies:manage',
  'fiscal-settings:read',
  'fiscal-settings:manage',
  'certificates:read',
  'certificates:manage',
  'webhooks:manage',
  'nfse:issue',
  'nfse:read',
  'nfse:cancel',
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/** A credencial com `granted` pode executar uma operação que exige `required`? */
export function scopeSatisfies(granted: ReadonlySet<Scope>, required: Scope): boolean {
  if (granted.has(required)) return true;
  if (required.endsWith(':read')) {
    const manage = `${required.slice(0, -':read'.length)}:manage`;
    return isScope(manage) && granted.has(manage);
  }
  return false;
}
