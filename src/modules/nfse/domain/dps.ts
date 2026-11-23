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
/**
 * TSTipoImunidadeISSQN (contrato v2, ADR-0040): 0 não informado na nota de origem; 1 a 5, alíneas
 * a a e do art. 150, VI, da CF88. Escolha do contribuinte.
 */
export const ISSQN_IMMUNITY_TYPES = ['0', '1', '2', '3', '4', '5'] as const;
/** TSTipoCST (CST do PIS/COFINS, ADR-0041). Escolha do contribuinte. */
export const PIS_COFINS_CSTS = [
  '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '49', '50', '51', '52', '53', '54', '55', '56',
  '60', '61', '62', '63', '64', '65', '66', '67', '70', '71', '72', '73', '74', '75', '98', '99',
] as const;
/**
 * TSTipoRetPISCofins (ADR-0041): quais contribuições retidas compõem o `vRetCSLL`. 0 PIS/COFINS/CSLL
 * não retidos; 1 PIS/COFINS retidos; 2 PIS/COFINS não retidos; 3 a 9, as combinações do XSD.
 */
export const PIS_COFINS_RETENTION_TYPES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** TSOpExigSuspensa (ADR-0043): 1 decisão judicial; 2 processo administrativo. */
export const ISSQN_SUSPENSION_TYPES = ['1', '2'] as const;

/** exigSusp (TCExigSuspensa, ADR-0043). */
export interface IssqnSuspension {
  readonly type: (typeof ISSQN_SUSPENSION_TYPES)[number];
  /** nProcesso (TSNumProcExigSuspensa, 30 dígitos). */
  readonly processNumber: string;
}

/**
 * BM (TCBeneficioMunicipal, ADR-0043): o identificador do benefício cadastrado pelo município e,
 * conforme o tipo do benefício, a redução da base por valor ou por percentual. O tipo do benefício
 * é do cadastro do município: quem confere a combinação é o autorizador.
 */
export interface MunicipalBenefit {
  /** nBM (TSNumBeneficioMunicipal, 14 dígitos). */
  readonly id: string;
  readonly reduction?:
    | { readonly kind: 'AMOUNT'; /** vRedBCBM (R$). */ readonly amount: string }
    | { readonly kind: 'PERCENTAGE'; /** pRedBCBM (%). */ readonly rate: string }
    | undefined;
}

/** vDescCondIncond (ADR-0041): ao menos um dos dois. */
export interface Discounts {
  /** vDescIncond (R$). */
  readonly unconditional?: string | undefined;
  /** vDescCond (R$). */
  readonly conditional?: string | undefined;
}

/**
 * Dedução/redução da base de cálculo do ISSQN (ADR-0042), por percentual ou por valor. Vira `vDedRed`
 * (`pDR`/`vDR`) no pacote de produção de 09/02/2026 e `vAjusteBC` (`pAjusteBCISSQN`/`vAjusteBCISSQN`)
 * no de produção restrita de 20/10/2026. A dedução por documentos fica para depois.
 */
export type IssqnDeduction =
  | { readonly kind: 'PERCENTAGE'; /** % (TSDec3V2). */ readonly rate: string }
  | { readonly kind: 'AMOUNT'; /** R$ (TSDec15V2). */ readonly amount: string };

/** tribFed (TCTribFederal, ADR-0041): valores do contribuinte; o motor não calcula nenhum. */
export interface FederalTaxes {
  /** piscofins (TCTribOutrosPisCofins). */
  readonly pisCofins?:
    | {
        readonly cst: (typeof PIS_COFINS_CSTS)[number];
        /** vBCPisCofins (R$). */
        readonly baseAmount?: string | undefined;
        /** pAliqPis (%). */
        readonly pisRate?: string | undefined;
        /** pAliqCofins (%). */
        readonly cofinsRate?: string | undefined;
        /** vPis (R$). */
        readonly pisAmount?: string | undefined;
        /** vCofins (R$). */
        readonly cofinsAmount?: string | undefined;
        /** tpRetPisCofins. */
        readonly retentionType?: (typeof PIS_COFINS_RETENTION_TYPES)[number] | undefined;
      }
    | undefined;
  /** vRetCP: contribuição previdenciária retida (R$). */
  readonly socialSecurityWithheld?: string | undefined;
  /** vRetIRRF: IRRF retido (R$). */
  readonly incomeTaxWithheld?: string | undefined;
  /** vRetCSLL: PIS, COFINS e CSLL retidos, conforme o tpRetPisCofins (R$). */
  readonly contributionsWithheld?: string | undefined;
}

export type FederalDocument = { readonly type: 'CNPJ'; readonly value: string } | { readonly type: 'CPF'; readonly value: string };

/** TSCodNaoNIF (ADR-0044): 0 não informado na nota de origem; 1 dispensado do NIF; 2 não exigência do NIF. */
export const NO_NIF_REASONS = ['0', '1', '2'] as const;

/**
 * Identificação do tomador ou do intermediário (choice de TCInfoPessoa). NIF e cNaoNIF são de
 * pessoa no exterior (ADR-0044).
 */
export type PartyDocument =
  | FederalDocument
  | { readonly type: 'NIF'; /** TSNIF (1–40). */ readonly value: string }
  | { readonly type: 'NO_NIF'; /** cNaoNIF. */ readonly reason: (typeof NO_NIF_REASONS)[number] };

/** TCEndereco com endExt (ADR-0044): país ISO2, código postal, cidade e estado/província/região. */
export interface ForeignAddress {
  /** cPais (TSCodPaisISO). */
  readonly countryCode: string;
  /** cEndPost (1–11). */
  readonly postalCode: string;
  /** xCidade (1–60). */
  readonly city: string;
  /** xEstProvReg (1–60). */
  readonly region: string;
  readonly street: string;
  readonly number: string;
  readonly complement?: string | undefined;
  readonly district: string;
}

export type PartyAddress = NationalAddress | ForeignAddress;

export const isForeignAddress = (a: PartyAddress | undefined): a is ForeignAddress => a !== undefined && 'countryCode' in a;
export const isNationalAddress = (a: PartyAddress | undefined): a is NationalAddress => a !== undefined && !('countryCode' in a);

/** Comércio exterior (TCComExterior, ADR-0044). Enumerações do XSD; escolha do contribuinte. */
export const FOREIGN_TRADE_MODES = ['0', '1', '2', '3', '4'] as const; // TSModoPrestacao
export const FOREIGN_TRADE_RELATIONSHIPS = ['0', '1', '2', '3', '4', '5', '6', '9'] as const; // TSVincPrest
export const FOREIGN_TRADE_PROVIDER_SUPPORT = ['00', '01', '02', '03', '04', '05', '06', '07', '08'] as const; // TSMecAFComExPrest
export const FOREIGN_TRADE_TAKER_SUPPORT = [
  '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26',
] as const; // TSMecAFComExToma
export const TEMPORARY_GOODS_MOVEMENTS = ['0', '1', '2', '3'] as const; // TSMovTempBens

export interface ForeignTrade {
  /** mdPrestacao. */
  readonly mode: (typeof FOREIGN_TRADE_MODES)[number];
  /** vincPrest. */
  readonly relationship: (typeof FOREIGN_TRADE_RELATIONSHIPS)[number];
  /** tpMoeda (TSCodMoeda, 3 dígitos). */
  readonly currencyCode: string;
  /** vServMoeda (TSDec15V2). */
  readonly amountInCurrency: string;
  /** mecAFComexP. */
  readonly providerSupport: (typeof FOREIGN_TRADE_PROVIDER_SUPPORT)[number];
  /** mecAFComexT. */
  readonly takerSupport: (typeof FOREIGN_TRADE_TAKER_SUPPORT)[number];
  /** movTempBens. */
  readonly temporaryGoods: (typeof TEMPORARY_GOODS_MOVEMENTS)[number];
  /** nDI (1–12). */
  readonly importDeclaration?: string | undefined;
  /** nRE (1–12). */
  readonly exportRegistration?: string | undefined;
  /** mdic: compartilhar com a Secretaria de Comércio Exterior. */
  readonly shareWithMdic: boolean;
}

/**
 * Endereço nacional (TCEndereco com `endNac`, contrato v2). O endereço no exterior (`endExt`) fica
 * para quando o contrato aceitar NIF.
 */
export interface NationalAddress {
  /** cMun (IBGE, 7 dígitos). */
  readonly municipalityCode: string;
  /** CEP (8 dígitos). */
  readonly postalCode: string;
  /** xLgr (1–255). */
  readonly street: string;
  /** nro (1–60). */
  readonly number: string;
  /** xCpl (1–156). */
  readonly complement?: string | undefined;
  /** xBairro (1–60). */
  readonly district: string;
}

/** Tomador ou intermediário (TCInfoPessoa), identificado por CNPJ, CPF, NIF ou cNaoNIF. */
export interface Party {
  readonly document: PartyDocument;
  readonly name: string;
  readonly municipalRegistration?: string | undefined;
  /** v2 (nacional); exterior no ADR-0044. */
  readonly address?: PartyAddress | undefined;
  /** fone (TSTelefone, 6–20 dígitos), v2. */
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
}

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
  readonly taker?: Party | undefined;
  /** interm (contrato v2). */
  readonly intermediary?: Party | undefined;
  readonly service: {
    /** cLocPrestacao (IBGE, 7 dígitos). Exatamente um entre este e `countryCode` (choice de TCLocPrest). */
    readonly municipalityCode?: string | undefined;
    /** cPaisPrestacao (ISO2): prestação no exterior (ADR-0045). */
    readonly countryCode?: string | undefined;
    /** cTribNac (6 dígitos). */
    readonly nationalTaxCode: string;
    /** cTribMun (3 dígitos). */
    readonly municipalTaxCode?: string | undefined;
    /** cNBS (9 dígitos). */
    readonly nbsCode?: string | undefined;
    /** xDescServ. */
    readonly description: string;
    /** comExt (ADR-0044). */
    readonly foreignTrade?: ForeignTrade | undefined;
  };
  readonly values: {
    /** vServ (R$, ponto decimal). */
    readonly serviceAmount: string;
    /** vDescCondIncond (ADR-0041). */
    readonly discounts?: Discounts | undefined;
    /** vDedRed | vAjusteBC, conforme o pacote (ADR-0042). */
    readonly deduction?: IssqnDeduction | undefined;
    readonly issqn: {
      readonly taxation: (typeof ISSQN_TAXATIONS)[number];
      readonly retention: (typeof ISSQN_RETENTIONS)[number];
      /** pAliq (%). */
      readonly rate?: string | undefined;
      /** tpImunidade (contrato v2), só com tribISSQN = 2. */
      readonly immunityType?: (typeof ISSQN_IMMUNITY_TYPES)[number] | undefined;
      /** cPaisResult (ADR-0044): país do resultado do serviço, na exportação. */
      readonly resultCountryCode?: string | undefined;
      /** exigSusp (ADR-0043). */
      readonly suspension?: IssqnSuspension | undefined;
      /** BM (ADR-0043). */
      readonly municipalBenefit?: MunicipalBenefit | undefined;
    };
    /** tribFed (ADR-0041). */
    readonly federalTaxes?: FederalTaxes | undefined;
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
