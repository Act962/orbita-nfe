import { GENESIS_HASH_HEX, entryPayload, type AuditEntry } from '../domain/audit-entry.js';

export type AuditChainRef = { readonly kind: 'COMPANY'; readonly companyId: string } | { readonly kind: 'PLATFORM' };

export interface StoredAuditEntry extends AuditEntry {
  readonly prevHashHex: string;
  readonly hashHex: string;
}

export interface AuditChainHead {
  readonly sequence: number;
  readonly hashHex: string;
}

/** Leitura da cadeia (papel do operador). */
export interface AuditChainReader {
  /** Registros com sequência > `afterSequence`, em ordem crescente. */
  page(chain: AuditChainRef, afterSequence: number, limit: number): Promise<StoredAuditEntry[]>;
  head(chain: AuditChainRef): Promise<AuditChainHead | undefined>;
}

export interface ChainHasher {
  /** SHA-256(prev_hash ‖ payload), em hexadecimal. */
  link(prevHashHex: string, payload: string): string;
}

export type AuditVerification =
  | { readonly ok: true; readonly entries: number; readonly head: AuditChainHead | undefined }
  | {
      readonly ok: false;
      readonly sequence: number;
      readonly reason: 'SEQUENCE_GAP' | 'BROKEN_LINK' | 'HASH_MISMATCH' | 'HEAD_MISMATCH';
    };

const PAGE = 500;

/**
 * Recalcula a cadeia inteira (docs/architecture/14 §A4). Detecta registro alterado
 * (HASH_MISMATCH), removido ou inserido fora de ordem (SEQUENCE_GAP / BROKEN_LINK) e
 * cabeça adulterada ou registros apagados do fim (HEAD_MISMATCH).
 */
export class AuditVerifier {
  constructor(
    private readonly reader: AuditChainReader,
    private readonly hasher: ChainHasher,
  ) {}

  async verify(chain: AuditChainRef): Promise<AuditVerification> {
    let expectedSequence = 1;
    let previousHash = GENESIS_HASH_HEX;
    let count = 0;

    for (;;) {
      const page = await this.reader.page(chain, expectedSequence - 1, PAGE);
      for (const entry of page) {
        if (entry.sequence !== expectedSequence) return { ok: false, sequence: expectedSequence, reason: 'SEQUENCE_GAP' };
        if (entry.prevHashHex !== previousHash) return { ok: false, sequence: entry.sequence, reason: 'BROKEN_LINK' };
        if (this.hasher.link(previousHash, entryPayload(entry)) !== entry.hashHex) {
          return { ok: false, sequence: entry.sequence, reason: 'HASH_MISMATCH' };
        }
        previousHash = entry.hashHex;
        expectedSequence += 1;
        count += 1;
      }
      if (page.length < PAGE) break;
    }

    const head = await this.reader.head(chain);
    const headMatches = head === undefined ? count === 0 : head.sequence === count && head.hashHex === previousHash;
    if (!headMatches) return { ok: false, sequence: count, reason: 'HEAD_MISMATCH' };
    return { ok: true, entries: count, head };
  }
}
