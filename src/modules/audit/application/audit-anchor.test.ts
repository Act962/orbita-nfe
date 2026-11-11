import { describe, expect, it } from 'vitest';
import { AuditAnchorer, anchorKey, parseAnchor, serializeAnchor, type AnchorStore, type ChainAnchor, type StoredAnchor } from './audit-anchor.js';

const COMPANY = { kind: 'COMPANY' as const, companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20' };
const HASH = 'ab'.repeat(32);
const at = new Date('2026-11-11T06:00:00.123Z');

describe('âncora da auditoria', () => {
  it('serializa e lê de volta o mesmo conteúdo', () => {
    const anchor: ChainAnchor = { chain: COMPANY, sequence: 42, hashHex: HASH, anchoredAt: at };
    expect(parseAnchor(serializeAnchor(anchor))).toEqual(anchor);
    expect(parseAnchor(serializeAnchor({ ...anchor, chain: { kind: 'PLATFORM' } })).chain).toEqual({ kind: 'PLATFORM' });
  });

  it('recusa documento adulterado ou de outro formato', () => {
    const good = JSON.parse(serializeAnchor({ chain: COMPANY, sequence: 1, hashHex: HASH, anchoredAt: at })) as Record<string, unknown>;
    for (const bad of [{ ...good, format: 'x' }, { ...good, hash: 'zz' }, { ...good, sequence: 0 }, { ...good, chain: { kind: 'COMPANY', companyId: '1' } }]) {
      expect(() => parseAnchor(JSON.stringify(bad))).toThrow('ANCHOR_MALFORMED');
    }
  });

  it('chave ordenável no tempo e separada por cadeia', () => {
    const first = anchorKey({ chain: COMPANY, sequence: 9, hashHex: HASH, anchoredAt: at });
    const later = anchorKey({ chain: COMPANY, sequence: 10, hashHex: HASH, anchoredAt: new Date(at.getTime() + 86_400_000) });
    expect(first).toBe(`audit-anchors/v1/company/${COMPANY.companyId}/20261111T060000123Z-9.json`);
    expect(later > first).toBe(true);
    expect(anchorKey({ chain: { kind: 'PLATFORM' }, sequence: 1, hashHex: HASH, anchoredAt: at })).toMatch(/^audit-anchors\/v1\/platform\//);
  });

  it('ancora a cabeça atual; cadeia vazia não gera âncora', async () => {
    const stored: ChainAnchor[] = [];
    const store: AnchorStore = {
      put: (anchor) => {
        stored.push(anchor);
        return Promise.resolve({ ...anchor, location: anchorKey(anchor), retainUntil: null } satisfies StoredAnchor);
      },
      latest: () => Promise.resolve(undefined),
    };
    const heads = new Map([[COMPANY.companyId, { sequence: 7, hashHex: HASH }]]);
    const anchorer = new AuditAnchorer({ head: (c) => Promise.resolve(c.kind === 'COMPANY' ? heads.get(c.companyId) : undefined) }, store, () => at);
    expect((await anchorer.anchor(COMPANY)).kind).toBe('ANCHORED');
    expect(await anchorer.anchor({ kind: 'PLATFORM' })).toEqual({ kind: 'EMPTY_CHAIN' });
    expect(stored).toEqual([{ chain: COMPANY, sequence: 7, hashHex: HASH, anchoredAt: at }]);
  });
});
