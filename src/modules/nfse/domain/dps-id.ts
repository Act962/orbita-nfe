import { err, ok, type Result } from '../../../shared/domain/result.js';

/**
 * Identificador da DPS (`infDPS/@Id`, tipo `TSIdDPS`).
 *
 * Fonte: documentação do tipo `TSIdDPS` nos XSD oficiais da NFS-e Nacional
 * (`tiposSimples_v1.01.xsd`, pacotes 1.01-20260209 e 1.01-20261020-prodrest):
 *
 *   "DPS" + Cód.Mun (7) + Tipo de Inscrição Federal (1) + Inscrição Federal (14 - CPF completar
 *   com 000 à esquerda) + Série DPS (5) + Núm. DPS (15)
 *
 * O padrão do pacote de 20/10/2026, `DPS[0-9]{7}(1[0-9]{14}|2[0-9A-Z]{14})[0-9]{20}`, liga o tipo
 * 1 ao CPF (só dígitos) e o tipo 2 ao CNPJ (alfanumérico). Série e número entram com zeros à
 * esquerda até 5 e 15 posições.
 */
export type FederalRegistration = { readonly kind: 'CNPJ'; readonly value: string } | { readonly kind: 'CPF'; readonly value: string };

export interface DpsIdInput {
  readonly municipalityCode: string;
  readonly registration: FederalRegistration;
  readonly series: string;
  readonly number: number;
}

export type DpsIdError = 'MUNICIPALITY_INVALID' | 'REGISTRATION_INVALID' | 'SERIES_INVALID' | 'NUMBER_INVALID';

export function buildDpsId(input: DpsIdInput): Result<string, DpsIdError> {
  if (!/^[0-9]{7}$/.test(input.municipalityCode)) return err('MUNICIPALITY_INVALID');
  let registration: string;
  if (input.registration.kind === 'CNPJ') {
    if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(input.registration.value)) return err('REGISTRATION_INVALID');
    registration = `2${input.registration.value}`;
  } else {
    if (!/^[0-9]{11}$/.test(input.registration.value)) return err('REGISTRATION_INVALID');
    registration = `1${input.registration.value.padStart(14, '0')}`;
  }
  if (!/^[0-9]{1,5}$/.test(input.series)) return err('SERIES_INVALID');
  if (!Number.isSafeInteger(input.number) || input.number < 1 || input.number > 999_999_999_999_999) return err('NUMBER_INVALID');
  return ok(`DPS${input.municipalityCode}${registration}${input.series.padStart(5, '0')}${String(input.number).padStart(15, '0')}`);
}
