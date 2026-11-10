import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, entryPayload, invalidDetailKeys, type AuditEntry } from './audit-entry.js';

const entry: AuditEntry = {
  companyId: '0192f3a0-7c4e-7a51-9d2b-3f6c1e8a4b20',
  sequence: 1,
  occurredAt: new Date('2026-11-10T12:00:00.123Z'),
  action: 'company.registered',
  actor: { kind: 'CLIENT_APPLICATION', clientApplicationId: 'app', credentialRef: 'cred' },
  subjectType: 'company',
  subjectId: 'c1',
  correlationId: 'corr',
  details: { b: 1, a: 'x', list: ['z', 'y'] },
};

describe('canonicalJson', () => {
  it('ordena as chaves em qualquer profundidade e não tem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: null } })).toBe('{"a":{"c":null,"d":true},"b":1}');
  });

  it('propriedade: a ordem de inserção das chaves não muda o resultado', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(record));
        expect(JSON.parse(canonicalJson(record))).toEqual(record);
      }),
    );
  });

  it('recusa números não inteiros (representação ambígua)', () => {
    expect(() => canonicalJson({ v: 1.5 })).toThrow();
    expect(() => canonicalJson({ v: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});

describe('entryPayload', () => {
  it('muda se qualquer campo do registro mudar (inclusive empresa e sequência)', () => {
    const base = entryPayload(entry);
    const variants: AuditEntry[] = [
      { ...entry, companyId: null },
      { ...entry, sequence: 2 },
      { ...entry, occurredAt: new Date(entry.occurredAt.getTime() + 1) },
      { ...entry, action: 'company.other' },
      { ...entry, actor: { kind: 'OPERATOR', operator: 'app' } },
      { ...entry, subjectId: 'c2' },
      { ...entry, correlationId: null },
      { ...entry, details: { ...entry.details, b: 2 } },
    ];
    for (const variant of variants) expect(entryPayload(variant)).not.toBe(base);
    expect(entryPayload({ ...entry, details: { list: ['z', 'y'], a: 'x', b: 1 } })).toBe(base);
  });
});

describe('invalidDetailKeys', () => {
  const sensitive = (key: string): boolean => /password|secret/i.test(key);
  it('recusa chaves sensíveis e valores fora dos tipos permitidos', () => {
    expect(invalidDetailKeys({ ok: 'x', n: 1, b: false, z: null, l: ['a'] }, sensitive)).toEqual([]);
    expect(invalidDetailKeys({ password: 'x', secretValue: 'y', frac: 1.5, list: [1] as unknown as string[] }, sensitive)).toEqual([
      'password',
      'secretValue',
      'frac',
      'list',
    ]);
  });
});
