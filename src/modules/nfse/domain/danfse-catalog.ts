/**
 * Descrições das opções impressas no DANFSe (NT 008 SE/CGNFS-e v1.02, item 2.4.5: "Utilizar a
 * descrição destas opções").
 *
 * Fonte de cada texto: a anotação `xs:documentation` do tipo simples em `tiposSimples_v1.01.xsd`,
 * igual nos dois pacotes versionados (1.01-20260209 e 1.01-20261020-prodrest). Os textos são
 * copiados sem reescrita; só o separador ("1 - ") e o ponto e vírgula final saem. Código fora da
 * lista devolve `undefined`: o DANFSe imprime o próprio código, nunca uma descrição deduzida.
 */
type Catalog = Readonly<Record<string, string>>;

/** TSEmitenteDPS: emitente da DPS. */
export const TP_EMIT: Catalog = { '1': 'Prestador', '2': 'Tomador', '3': 'Intermediário' };

/** TSRTCFinNFSe: indicador da finalidade da emissão de NFS-e. */
export const FIN_NFSE: Catalog = { '0': 'NFS-e regular' };

/** TSOpSimpNac: situação perante o Simples Nacional. */
export const OP_SIMP_NAC: Catalog = {
  '1': 'Não Optante',
  '2': 'Optante - Microempreendedor Individual (MEI)',
  '3': 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
};

/** TSRegimeApuracaoSimpNac: regime de apuração dos tributos pelo Simples Nacional. */
export const REG_AP_TRIB_SN: Catalog = {
  '1': 'Regime de apuração dos tributos federais e municipal pelo SN',
  '2': 'Regime de apuração dos tributos federais pelo SN e ISSQN por fora do SN conforme respectiva legislação municipal do tributo',
  '3': 'Regime de apuração dos tributos federais e municipal por fora do SN conforme respectivas legislações federal e municipal de cada tributo',
};

/** TSRegEspTrib: tipos de regimes especiais de tributação. */
export const REG_ESP_TRIB: Catalog = {
  '0': 'Nenhum',
  '1': 'Ato Cooperado (Cooperativa)',
  '2': 'Estimativa',
  '3': 'Microempresa Municipal',
  '4': 'Notário ou Registrador',
  '5': 'Profissional Autônomo',
  '6': 'Sociedade de Profissionais',
  '9': 'Outros',
};

/** TSTribISSQN: tributação do ISSQN sobre o serviço prestado. */
export const TRIB_ISSQN: Catalog = { '1': 'Operação tributável', '2': 'Imunidade', '3': 'Exportação de serviço', '4': 'Não Incidência' };

/** TSTipoImunidadeISSQN: tipos de imunidades. */
export const TP_IMUNIDADE: Catalog = {
  '0': 'Imunidade (tipo não informado na nota de origem)',
  '1': 'Patrimônio, renda ou serviços, uns dos outros (CF88, Art 150, VI, a)',
  '2': 'Templos de qualquer culto (CF88, Art 150, VI, b)',
  '3':
    'Patrimônio, renda ou serviços dos partidos políticos, inclusive suas fundações, das entidades sindicais dos trabalhadores, das instituições de educação e de assistência social, sem fins lucrativos, atendidos os requisitos da lei (CF88, Art 150, VI, c)',
  '4': 'Livros, jornais, periódicos e o papel destinado a sua impressão (CF88, Art 150, VI, d)',
  '5':
    'Fonogramas e videofonogramas musicais produzidos no Brasil contendo obras musicais ou literomusicais de autores brasileiros e/ou obras em geral interpretadas por artistas brasileiros bem como os suportes materiais ou arquivos digitais que os contenham, salvo na etapa de replicação industrial de mídias ópticas de leitura a laser. (CF88, Art 150, VI, e)',
};

/** TSTipoRetISSQN: tipo de retenção do ISSQN. */
export const TP_RET_ISSQN: Catalog = { '1': 'Não Retido', '2': 'Retido pelo Tomador', '3': 'Retido pelo Intermediario' };

/** TSOpExigSuspensa: opção para exigibilidade suspensa (são também as descrições do item 2.4.5 da NT). */
export const TP_SUSP: Catalog = { '1': 'Exigibilidade Suspensa por Decisão Judicial', '2': 'Exigibilidade Suspensa por Processo Administrativo' };

/** TSTipoRetPISCofins: tipo de retenção do PIS/COFINS. */
export const TP_RET_PIS_COFINS: Catalog = {
  '0': 'PIS/COFINS/CSLL Não Retidos',
  '1': 'PIS/COFINS Retidos',
  '2': 'PIS/COFINS Não Retidos',
  '3': 'PIS/COFINS/CSLL Retidos',
  '4': 'PIS/COFINS Retidos, CSLL Não Retido',
  '5': 'PIS Retido, COFINS/CSLL Não Retido',
  '6': 'COFINS Retido, PIS/CSLL Não Retido',
  '7': 'PIS Não Retido, COFINS/CSLL Retidos',
  '8': 'PIS/COFINS Não Retidos, CSLL Retido',
  '9': 'COFINS Não Retido, PIS/CSLL Retidos',
};

/** TBMISSQN: tipo do benefício municipal. O XSD descreve 2 a 4 citando o campo do valor; o texto vai como está. */
export const TP_BM: Catalog = {
  '1': 'Isenção',
  '2': "Redução da BC em 'ppBM' %",
  '3': "Redução da BC em R$ 'vInfoBM'",
  '4': "Alíquota Diferenciada de 'aliqDifBM' %",
};

/** Descrição oficial do código, ou `undefined` (o chamador imprime o código). */
export function describe(catalog: Catalog, code: string | undefined): string | undefined {
  return code === undefined ? undefined : catalog[code];
}
