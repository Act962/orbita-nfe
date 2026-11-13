/**
 * Dados da DPS enviados pelo cliente (contrato v1, ADR-0033). Cada campo corresponde a um
 * elemento do XSD oficial da NFS-e Nacional (`tiposComplexos_v1.01.xsd`); a tabela completa,
 * com a origem de cada um, está em docs/fiscal/contrato-dps-v1.md.
 *
 * O motor NÃO escolhe nenhum destes valores (ADR-0018): opção pelo Simples, regime, código de
 * tributação, alíquota, retenção e totais aproximados vêm do cliente, validados contra as
 * enumerações e padrões do XSD. Regras condicionais entre campos (L3) são do autorizador até
 * serem catalogadas com fonte.
 */
export const SIMPLES_NACIONAL_OPTIONS = ['1', '2', '3'] as const; // TSOpSimpNac
export const SIMPLES_NACIONAL_REGIMES = ['1', '2', '3'] as const; // TSRegimeApuracaoSimpNac
export const SPECIAL_TAX_REGIMES = ['0', '1', '2', '3', '4', '5', '6', '9'] as const; // TSRegEspTrib
export const ISSQN_TAXATIONS = ['1', '2', '3', '4'] as const; // TSTribISSQN
export const ISSQN_RETENTIONS = ['1', '2', '3'] as const; // TSTipoRetISSQN

export type FederalDocument = { readonly type: 'CNPJ'; readonly value: string } | { readonly type: 'CPF'; readonly value: string };

export type ApproximateTaxes =
  /** vTotTrib: valores em R$ (Lei 12.741/2012). */
  | { readonly kind: 'AMOUNTS'; readonly federal: string; readonly state: string; readonly municipal: string }
  /** pTotTrib: percentuais. */
  | { readonly kind: 'PERCENTAGES'; readonly federal: string; readonly state: string; readonly municipal: string }
  /** pTotTribSN: percentual aproximado da alíquota do Simples Nacional. */
  | { readonly kind: 'SIMPLES_NACIONAL_RATE'; readonly rate: string }
  /** indTotTrib = 0: não informar. */
  | { readonly kind: 'NOT_INFORMED' };

export interface DpsData {
  /** dCompet (AAAA-MM-DD). Também decide o canal de emissão em Teresina (ADR-0028). */
  readonly competenceDate: string;
  readonly provider: {
    readonly simplesNacionalOption: (typeof SIMPLES_NACIONAL_OPTIONS)[number];
    readonly simplesNacionalRegime?: (typeof SIMPLES_NACIONAL_REGIMES)[number] | undefined;
    readonly specialTaxRegime: (typeof SPECIAL_TAX_REGIMES)[number];
    readonly municipalRegistration?: string | undefined;
  };
  readonly taker?:
    | {
        readonly document: FederalDocument;
        readonly name: string;
        readonly municipalRegistration?: string | undefined;
        readonly email?: string | undefined;
      }
    | undefined;
  readonly service: {
    /** cLocPrestacao (IBGE, 7 dígitos). */
    readonly municipalityCode: string;
    /** cTribNac (6 dígitos). */
    readonly nationalTaxCode: string;
    /** cTribMun (3 dígitos). */
    readonly municipalTaxCode?: string | undefined;
    /** cNBS (9 dígitos). */
    readonly nbsCode?: string | undefined;
    /** xDescServ. */
    readonly description: string;
  };
  readonly values: {
    /** vServ (R$, ponto decimal). */
    readonly serviceAmount: string;
    readonly issqn: {
      readonly taxation: (typeof ISSQN_TAXATIONS)[number];
      readonly retention: (typeof ISSQN_RETENTIONS)[number];
      /** pAliq (%). */
      readonly rate?: string | undefined;
    };
    readonly approximateTaxes: ApproximateTaxes;
  };
}

/**
 * Data (AAAA-MM-DD) em horário de Brasília (UTC−03:00), o mesmo fuso do dhEmi (ADR-0033 item 4,
 * provisório: R-38).
 */
export function brasiliaDate(at: Date): string {
  return new Date(at.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

/** tpAmb (TSTipoAmbiente): 1 - Produção; 2 - Homologação. */
export function tpAmbOf(environment: 'PRODUCTION' | 'HOMOLOGATION'): '1' | '2' {
  return environment === 'PRODUCTION' ? '1' : '2';
}

/** Município e CNPJ do emitente, lidos do Id da DPS (TSIdDPS), que foi montado no aceite. */
export function issuerFromDpsId(dpsId: string): { municipalityCode: string; cnpj: string } | undefined {
  const match = /^DPS([0-9]{7})2([0-9A-Z]{12}[0-9]{2})[0-9]{20}$/.exec(dpsId);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { municipalityCode: match[1], cnpj: match[2] };
}
