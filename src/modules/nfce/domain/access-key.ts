import { Cnpj } from '../../../shared/domain/cnpj.js';
import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Chave de acesso da NF-e/NFC-e 4.00 (ADR-0065).
 *
 * Fontes:
 * - MOC 7.0, Visão Geral, Tabela 2-1: cUF(2) + AAMM(4) + CNPJ(14) + mod(2) + serie(3) + nNF(9) +
 *   tpEmis(1) + cNF(8) + cDV(1) = 44 posições; DV por módulo 11, pesos 2 a 9 da direita para a
 *   esquerda, resto 0 ou 1 → DV 0 (exemplo do MOC: DV 5);
 * - NT Conjunta 2025.001, item 5: com CNPJ alfanumérico, cada caractere vale (código ASCII − 48)
 *   antes do módulo 11 (dígitos não mudam; A = 17, B = 18…); formato
 *   `[0-9]{6}[A-Z0-9]{12}[0-9]{26}`;
 * - NT 2019.001, regra B03-10 (cStat 897): cNF não pode ser uma das 20 sequências listadas nem
 *   igual ao nNF;
 * - MOC 7.0, item 4.2.3: o Id do `infNFe` é a chave precedida do literal "NFe".
 *
 * Só emitente CNPJ: a NFC-e por CPF (NT 2023.002) fica para quando houver necessidade.
 */
export const ACCESS_KEY_PATTERN = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;

/** B03-10 (NT 2019.001): sequências proibidas no cNF. */
const FORBIDDEN_NUMERIC_CODES = new Set([
  '00000000', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777', '88888888', '99999999',
  '12345678', '23456789', '34567890', '45678901', '56789012', '67890123', '78901234', '89012345', '90123456', '01234567',
]);

export type AccessKeyIssue =
  | 'ACCESS_KEY_INVALID_UF'
  | 'ACCESS_KEY_INVALID_YEAR_MONTH'
  | 'ACCESS_KEY_INVALID_CNPJ'
  | 'ACCESS_KEY_INVALID_SERIES'
  | 'ACCESS_KEY_INVALID_NUMBER'
  | 'ACCESS_KEY_INVALID_EMISSION_TYPE'
  | 'ACCESS_KEY_INVALID_NUMERIC_CODE';

export interface AccessKeyParts {
  /** Código IBGE da UF do emitente (2 dígitos). */
  readonly cUF: string;
  /** Ano e mês da emissão (AAMM), extraídos de dhEmi. */
  readonly yearMonth: string;
  readonly cnpj: string;
  readonly model: '55' | '65';
  /** 0 a 999 (a faixa de cada uso é regra de série, não da chave). */
  readonly series: number;
  /** 1 a 999.999.999. */
  readonly number: number;
  /** tpEmis (1 dígito). */
  readonly emissionType: string;
  /** cNF (8 dígitos), sorteado pelo emitente. */
  readonly numericCode: string;
}

export interface AccessKey {
  readonly value: string;
  /** Id do infNFe: "NFe" + chave. */
  readonly id: string;
  readonly checkDigit: string;
}

/** Módulo 11 sobre (ASCII − 48) de cada caractere, pesos 2..9 da direita para a esquerda. */
export function accessKeyCheckDigit(base43: string): string {
  let sum = 0;
  let weight = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += (base43.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? '0' : String(11 - rest);
}

/** B03-10: o cNF sorteado precisa passar aqui; se não passar, sorteia-se outro. */
export function isAcceptableNumericCode(numericCode: string, number: number): boolean {
  return /^[0-9]{8}$/.test(numericCode) && !FORBIDDEN_NUMERIC_CODES.has(numericCode) && Number(numericCode) !== number;
}

export function buildAccessKey(parts: AccessKeyParts): Result<AccessKey, AccessKeyIssue> {
  if (!/^[1-5][0-9]$/.test(parts.cUF)) return err('ACCESS_KEY_INVALID_UF');
  if (!/^[0-9]{2}(0[1-9]|1[0-2])$/.test(parts.yearMonth)) return err('ACCESS_KEY_INVALID_YEAR_MONTH');
  const cnpj = Cnpj.parse(parts.cnpj);
  if (!cnpj.ok) return err('ACCESS_KEY_INVALID_CNPJ');
  if (!Number.isInteger(parts.series) || parts.series < 0 || parts.series > 999) return err('ACCESS_KEY_INVALID_SERIES');
  if (!Number.isInteger(parts.number) || parts.number < 1 || parts.number > 999_999_999) return err('ACCESS_KEY_INVALID_NUMBER');
  if (!/^[0-9]$/.test(parts.emissionType)) return err('ACCESS_KEY_INVALID_EMISSION_TYPE');
  if (!isAcceptableNumericCode(parts.numericCode, parts.number)) return err('ACCESS_KEY_INVALID_NUMERIC_CODE');
  const base =
    parts.cUF +
    parts.yearMonth +
    cnpj.value.value +
    parts.model +
    String(parts.series).padStart(3, '0') +
    String(parts.number).padStart(9, '0') +
    parts.emissionType +
    parts.numericCode;
  const checkDigit = accessKeyCheckDigit(base);
  const value = base + checkDigit;
  return ok({ value, id: `NFe${value}`, checkDigit });
}

/** Confere formato e dígito de uma chave recebida (ex.: na consulta). */
export function isValidAccessKey(value: string): boolean {
  return ACCESS_KEY_PATTERN.test(value) && accessKeyCheckDigit(value.slice(0, 43)) === value.slice(43);
}
