/**
 * Situação da NFS-e gerada (`infNFSe/cStat`, tipo `TStat`), ADR-0054.
 *
 * Fonte: XSD oficial da NFS-e Nacional, `tiposSimples_v1.01.xsd`, tipo `TStat`, igual nos pacotes
 * `1.01-20260209` e `1.01-20261020-prodrest` (resources/fiscal/schemas/nfse-nacional). As descrições
 * são as da anotação do próprio XSD. Código fora desta lista é mostrado sem descrição: nunca
 * inventada.
 */
export const NFSE_STATUS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '100': 'NFS-e Gerada',
  '102': 'NFS-e de Decisão Judicial',
  '103': 'NFS-e Avulsa',
  '107': 'NFS-e MEI',
};

export const nfseStatusDescription = (code: string): string | null => NFSE_STATUS_DESCRIPTIONS[code] ?? null;
