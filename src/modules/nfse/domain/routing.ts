/**
 * Roteamento da NFS-e pela competência (ADR-0028). A tabela é DADO versionado
 * (`resources/fiscal/routing/`), com a fonte de cada linha; aqui só se aplica.
 *
 * - Sem linha aplicável → recusa (não há canal padrão).
 * - Linhas aplicáveis com canais diferentes → recusa (`AMBIGUOUS`): a tabela não define
 *   precedência e o motor não escolhe.
 * - Linha "a confirmar" → recusa até a fonte ser confirmada.
 *
 * Os valores de entrada (opSimpNac, regApTribSN) são do contribuinte (ADR-0018): o motor não
 * deduz o regime.
 */
export const ROUTING_CHANNELS = ['NATIONAL_SEFIN', 'MUNICIPAL_TERESINA_DSF', 'TO_CONFIRM'] as const;
export type RoutingChannel = (typeof ROUTING_CHANNELS)[number];

/** Canais com adapter implementado (ADR-0038 e ADR-0039). */
export const SUPPORTED_CHANNELS: readonly RoutingChannel[] = ['NATIONAL_SEFIN', 'MUNICIPAL_TERESINA_DSF'];

/**
 * Pacote de leiaute (XSD) e Anexo I que o canal usa, por ambiente do motor.
 * - SEFIN Nacional: produção → pacote de produção (09/02/2026); homologação → produção restrita
 *   (20/10/2026), como no ADR-0013.
 * - Emissor municipal de Teresina (DSF): o nacional v1.01 de 09/02/2026 nos DOIS ambientes. O
 *   portal e a Carta de Serviços da SEMF linkam esse pacote e esse Anexo I, e o Guia V7 (20/08/2026)
 *   é anterior ao pacote da produção restrita (diagnóstico §1.1 e §1.5). A confirmar no primeiro
 *   envio à homologação da DSF (ADR-0039).
 */
export function layoutEnvironmentOf(channel: string, environment: 'PRODUCTION' | 'HOMOLOGATION'): 'PRODUCTION' | 'HOMOLOGATION' {
  return channel === 'MUNICIPAL_TERESINA_DSF' ? 'PRODUCTION' : environment;
}

export interface RoutingRow {
  readonly id: string;
  /** IBGE do município do estabelecimento emitente, ou `*`. */
  readonly municipality: string;
  /** null = qualquer. */
  readonly simplesNacionalOption: readonly string[] | null;
  readonly simplesNacionalRegime: readonly string[] | null;
  /** AAAA-MM-DD, inclusivo. */
  readonly competenceFrom: string | null;
  /** AAAA-MM-DD, exclusivo. */
  readonly competenceBefore: string | null;
  readonly channel: RoutingChannel;
  readonly source: string;
}

export interface RoutingTable {
  readonly version: string;
  readonly rows: readonly RoutingRow[];
}

export interface RoutingInput {
  readonly municipalityCode: string;
  readonly simplesNacionalOption: string;
  readonly simplesNacionalRegime: string | undefined;
  /** dCompet, AAAA-MM-DD. */
  readonly competenceDate: string;
}

export type RoutingDecision =
  | { readonly kind: 'ROUTED'; readonly channel: RoutingChannel; readonly rows: readonly string[] }
  /** Nenhuma linha. `regimeWouldMatter`: alguma linha casaria se `regApTribSN` fosse informado. */
  | { readonly kind: 'NO_ROUTE'; readonly regimeWouldMatter: boolean }
  | { readonly kind: 'TO_CONFIRM'; readonly rows: readonly string[] }
  | { readonly kind: 'AMBIGUOUS'; readonly rows: readonly string[] };

export function route(table: RoutingTable, input: RoutingInput): RoutingDecision {
  const matching = table.rows.filter((row) => matches(row, input, true));
  if (matching.length === 0) {
    const regimeWouldMatter = input.simplesNacionalRegime === undefined && table.rows.some((row) => matches(row, input, false));
    return { kind: 'NO_ROUTE', regimeWouldMatter };
  }
  const rows = matching.map((r) => r.id);
  const channels = new Set(matching.map((r) => r.channel));
  if (channels.size > 1) return { kind: 'AMBIGUOUS', rows };
  const [channel] = channels;
  if (channel === undefined) throw new Error('inalcançável');
  if (channel === 'TO_CONFIRM') return { kind: 'TO_CONFIRM', rows };
  return { kind: 'ROUTED', channel, rows };
}

function matches(row: RoutingRow, input: RoutingInput, requireRegime: boolean): boolean {
  if (row.municipality !== '*' && row.municipality !== input.municipalityCode) return false;
  if (row.simplesNacionalOption !== null && !row.simplesNacionalOption.includes(input.simplesNacionalOption)) return false;
  if (row.simplesNacionalRegime !== null) {
    if (input.simplesNacionalRegime === undefined) {
      if (requireRegime) return false;
    } else if (!row.simplesNacionalRegime.includes(input.simplesNacionalRegime)) return false;
  }
  // AAAA-MM-DD compara como texto.
  if (row.competenceFrom !== null && input.competenceDate < row.competenceFrom) return false;
  if (row.competenceBefore !== null && input.competenceDate >= row.competenceBefore) return false;
  return true;
}
