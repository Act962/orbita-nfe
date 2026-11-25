import { join } from 'node:path';
import { z } from 'zod';
import type { FiscalReferenceTables } from '../../application/ports.js';
import { ReferenceResourceError, verifiedResource, type MunicipalityTable } from './municipality-table.js';

/**
 * ANEXO_A do Sistema Nacional NFS-e (ADR-0060): municípios IBGE, países ISO2 e localidade geral,
 * a tabela que as regras E0246, E0299, E0302 e E0304 do Anexo I citam. Hash conferido na carga.
 */
export interface AnexoA {
  readonly version: string;
  hasMunicipality(code: string): boolean;
  hasCountry(code: string): boolean;
  hasGeneralLocation(code: string): boolean;
}

const schema = z.object({
  version: z.string().regex(/^nfse-anexo-a\/v\d+\.\d+-\d{8}$/),
  municipalities: z.record(z.string().regex(/^\d{7}$/), z.string().min(1)),
  countries: z.record(z.string().regex(/^[A-Z]{2}$/), z.string().min(1)),
  generalLocations: z.record(z.string().regex(/^\d{7}$/), z.string().min(1)),
});

export function loadAnexoA(dir: string, file: string): AnexoA {
  const parsed = schema.safeParse(JSON.parse(verifiedResource(dir, file).toString('utf8')));
  if (!parsed.success) throw new ReferenceResourceError('REFERENCE_RESOURCE_INVALID', join(dir, file));
  const { municipalities, countries, generalLocations } = parsed.data;
  return {
    version: parsed.data.version,
    hasMunicipality: (code) => Object.hasOwn(municipalities, code),
    hasCountry: (code) => Object.hasOwn(countries, code),
    hasGeneralLocation: (code) => Object.hasOwn(generalLocations, code),
  };
}

/**
 * Tabelas de referência do aceite (ADR-0058, ADR-0060).
 *
 * - **Município:** existe se está no ANEXO_A **ou** na tabela atual do IBGE. O ANEXO_A v1.00 não
 *   tem municípios instalados depois dele (ex.: 5101837, Boa Esperança do Norte-MT); recusar aqui
 *   o que o autorizador pode aceitar seria pior do que deixar a recusa com ele.
 * - **País:** o ANEXO_A é a única tabela que a regra cita, e vale inteira.
 */
export function referenceTables(anexoA: AnexoA, ibge: MunicipalityTable): FiscalReferenceTables {
  return {
    municipalityExists: (code) => anexoA.hasMunicipality(code) || ibge.exists(code),
    countryExists: (code) => anexoA.hasCountry(code),
  };
}
