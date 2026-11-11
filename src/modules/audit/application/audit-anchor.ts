import type { AuditChainHead, AuditChainRef } from './audit-verifier.js';

/**
 * Âncora externa da cadeia de auditoria (docs/architecture/14 §A4, ADR-0031).
 *
 * Todo dia a cabeça de cada cadeia (sequência + hash) é gravada fora do banco, num bucket com
 * Object Lock em modo COMPLIANCE: nem o administrador da VPS nem quem tiver as credenciais do
 * bucket consegue apagar ou reescrever a âncora antes do fim da retenção. Quem adulterar o banco
 * e recalcular a cadeia inteira continua sendo pego: o hash ancorado não confere mais.
 *
 * A âncora só carrega identificadores e hashes: nenhum dado de auditoria sai do banco.
 */
export interface ChainAnchor {
  readonly chain: AuditChainRef;
  readonly sequence: number;
  readonly hashHex: string;
  readonly anchoredAt: Date;
}

export interface StoredAnchor extends ChainAnchor {
  /** Onde a âncora foi gravada (chave do objeto). */
  readonly location: string;
  readonly retainUntil: Date | null;
}

/** Armazenamento imutável das âncoras (adapter S3 com Object Lock). */
export interface AnchorStore {
  put(anchor: ChainAnchor): Promise<StoredAnchor>;
  /** A âncora mais recente da cadeia, ou undefined se nunca houve. */
  latest(chain: AuditChainRef): Promise<StoredAnchor | undefined>;
}

/** Cabeça da cadeia vista pelo processo que ancora (sem acesso aos registros). */
export interface AnchorHeadReader {
  head(chain: AuditChainRef): Promise<AuditChainHead | undefined>;
}

export type AnchorOutcome = { readonly kind: 'ANCHORED'; readonly anchor: StoredAnchor } | { readonly kind: 'EMPTY_CHAIN' };

export class AuditAnchorer {
  constructor(
    private readonly heads: AnchorHeadReader,
    private readonly store: AnchorStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Grava a cabeça atual. Repetir é inofensivo: cada execução vira mais um objeto imutável. */
  async anchor(chain: AuditChainRef): Promise<AnchorOutcome> {
    const head = await this.heads.head(chain);
    if (head === undefined || head.sequence === 0) return { kind: 'EMPTY_CHAIN' };
    return { kind: 'ANCHORED', anchor: await this.store.put({ chain, sequence: head.sequence, hashHex: head.hashHex, anchoredAt: this.now() }) };
  }
}

const ANCHOR_FORMAT = 'orbita-nfe.audit-anchor/1';

/** Documento gravado no bucket. Estável: a verificação de daqui a anos precisa ler o de hoje. */
export function serializeAnchor(anchor: ChainAnchor): string {
  return JSON.stringify({
    format: ANCHOR_FORMAT,
    chain: anchor.chain.kind === 'COMPANY' ? { kind: 'COMPANY', companyId: anchor.chain.companyId } : { kind: 'PLATFORM' },
    sequence: anchor.sequence,
    hash: anchor.hashHex,
    anchoredAt: anchor.anchoredAt.toISOString(),
  });
}

const HEX_256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAnchor(text: string): ChainAnchor {
  const value = JSON.parse(text) as Record<string, unknown>;
  const chain = value['chain'] as Record<string, unknown> | undefined;
  const sequence = value['sequence'];
  const hash = value['hash'];
  const anchoredAt = new Date(String(value['anchoredAt']));
  const valid =
    value['format'] === ANCHOR_FORMAT &&
    chain !== undefined &&
    (chain['kind'] === 'PLATFORM' || (chain['kind'] === 'COMPANY' && typeof chain['companyId'] === 'string' && UUID.test(chain['companyId']))) &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 1 &&
    typeof hash === 'string' &&
    HEX_256.test(hash) &&
    !Number.isNaN(anchoredAt.getTime());
  if (!valid) throw new Error('ANCHOR_MALFORMED');
  return {
    chain: chain['kind'] === 'PLATFORM' ? { kind: 'PLATFORM' } : { kind: 'COMPANY', companyId: String(chain['companyId']) },
    sequence,
    hashHex: hash,
    anchoredAt,
  };
}

/** Chave do objeto: prefixo por cadeia + instante, para a última ser a maior em ordem lexicográfica. */
export function anchorPrefix(chain: AuditChainRef): string {
  return chain.kind === 'PLATFORM' ? 'audit-anchors/v1/platform/' : `audit-anchors/v1/company/${chain.companyId}/`;
}

export function anchorKey(anchor: ChainAnchor): string {
  const stamp = anchor.anchoredAt.toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${anchorPrefix(anchor.chain)}${stamp}-${String(anchor.sequence)}.json`;
}
