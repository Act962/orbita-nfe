import { describe, expect, it } from 'vitest';
import { isScope, scopeSatisfies, SCOPES, type Scope } from './scope.js';

const set = (...s: Scope[]): ReadonlySet<Scope> => new Set(s);

describe('Scope', () => {
  it('catálogo segue <recurso>:<ação> sem duplicatas', () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
    for (const s of SCOPES) expect(s).toMatch(/^[a-z-]+:[a-z]+$/);
  });

  it('reconhece só escopos do catálogo', () => {
    expect(isScope('companies:read')).toBe(true);
    expect(isScope('companies:*')).toBe(false);
    expect(isScope('admin')).toBe(false);
  });

  it('escopo exato satisfaz', () => {
    expect(scopeSatisfies(set('nfse:issue'), 'nfse:issue')).toBe(true);
  });

  it(':manage implica :read do mesmo recurso, e só dele', () => {
    expect(scopeSatisfies(set('companies:manage'), 'companies:read')).toBe(true);
    expect(scopeSatisfies(set('companies:manage'), 'fiscal-settings:read')).toBe(false);
  });

  it(':read não implica :manage nem outras ações', () => {
    expect(scopeSatisfies(set('companies:read'), 'companies:manage')).toBe(false);
    expect(scopeSatisfies(set('nfse:read'), 'nfse:issue')).toBe(false);
    expect(scopeSatisfies(set('nfse:issue'), 'nfse:cancel')).toBe(false);
  });

  it('nfse:read não é satisfeito por um nfse:manage inexistente', () => {
    expect(scopeSatisfies(set(), 'nfse:read')).toBe(false);
  });
});
