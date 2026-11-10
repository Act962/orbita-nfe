import { describe, expect, it } from 'vitest';
import { sha256ChainHasher } from '../infrastructure/persistence/audit-store.js';
import { GENESIS_HASH_HEX, entryPayload, type AuditEntry } from '../domain/audit-entry.js';
import { AuditVerifier, type AuditChainHead, type AuditChainReader, type StoredAuditEntry } from './audit-verifier.js';

function buildChain(count: number): StoredAuditEntry[] {
  const out: StoredAuditEntry[] = [];
  let prev = GENESIS_HASH_HEX;
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const entry: AuditEntry = {
      companyId: 'c',
      sequence,
      occurredAt: new Date(1_800_000_000_000 + sequence),
      action: 'establishment.registered',
      actor: { kind: 'SYSTEM', process: 'teste' },
      subjectType: 'establishment',
      subjectId: `e${sequence}`,
      correlationId: null,
      details: { n: sequence },
    };
    const hashHex = sha256ChainHasher.link(prev, entryPayload(entry));
    out.push({ ...entry, prevHashHex: prev, hashHex });
    prev = hashHex;
  }
  return out;
}

function reader(entries: StoredAuditEntry[], head: AuditChainHead | undefined): AuditChainReader {
  return {
    page: (_chain, after, limit) => Promise.resolve(entries.filter((e) => e.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, limit)),
    head: () => Promise.resolve(head),
  };
}

const chain = { kind: 'COMPANY', companyId: 'c' } as const;
const headOf = (entries: StoredAuditEntry[]): AuditChainHead => {
  const last = entries[entries.length - 1];
  return last === undefined ? { sequence: 0, hashHex: GENESIS_HASH_HEX } : { sequence: last.sequence, hashHex: last.hashHex };
};

describe('AuditVerifier', () => {
  it('cadeia íntegra (mais de uma página) → ok', async () => {
    const entries = buildChain(1203);
    const result = await new AuditVerifier(reader(entries, headOf(entries)), sha256ChainHasher).verify(chain);
    expect(result).toMatchObject({ ok: true, entries: 1203 });
  });

  it('cadeia vazia sem cabeça → ok', async () => {
    expect(await new AuditVerifier(reader([], undefined), sha256ChainHasher).verify(chain)).toEqual({ ok: true, entries: 0, head: undefined });
  });

  it('registro alterado → HASH_MISMATCH na sequência alterada', async () => {
    const entries = buildChain(5);
    const head = headOf(entries);
    const target = entries[2];
    if (target === undefined) throw new Error('sem registro');
    entries[2] = { ...target, details: { n: 999 } };
    expect(await new AuditVerifier(reader(entries, head), sha256ChainHasher).verify(chain)).toEqual({ ok: false, sequence: 3, reason: 'HASH_MISMATCH' });
  });

  it('registro removido do meio → SEQUENCE_GAP', async () => {
    const entries = buildChain(5);
    const head = headOf(entries);
    entries.splice(1, 1);
    expect(await new AuditVerifier(reader(entries, head), sha256ChainHasher).verify(chain)).toEqual({ ok: false, sequence: 2, reason: 'SEQUENCE_GAP' });
  });

  it('registro e hash reescritos de forma consistente → BROKEN_LINK no seguinte', async () => {
    const entries = buildChain(4);
    const head = headOf(entries);
    const target = entries[1];
    if (target === undefined) throw new Error('sem registro');
    const rewritten = { ...target, details: { n: 42 } };
    entries[1] = { ...rewritten, hashHex: sha256ChainHasher.link(rewritten.prevHashHex, entryPayload(rewritten)) };
    expect(await new AuditVerifier(reader(entries, head), sha256ChainHasher).verify(chain)).toEqual({ ok: false, sequence: 3, reason: 'BROKEN_LINK' });
  });

  it('registros apagados do fim → HEAD_MISMATCH', async () => {
    const entries = buildChain(5);
    const head = headOf(entries);
    expect(await new AuditVerifier(reader(entries.slice(0, 3), head), sha256ChainHasher).verify(chain)).toEqual({
      ok: false,
      sequence: 3,
      reason: 'HEAD_MISMATCH',
    });
  });
});
