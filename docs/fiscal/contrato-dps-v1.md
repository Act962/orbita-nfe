# Contrato v1 da DPS — campos da API e origem no XSD oficial

Decisão: [ADR-0033](../adr/0033-contrato-dps-v1.md).

> **Limite conhecido (2026-11-13, ADR-0037):** o Anexo I exige grupos que este contrato não tem. Sem eles, quatro casos são recusados no aceite: tomador identificado por CNPJ (E0235, endereço nacional do tomador), retenção pelo tomador (E0237) ou pelo intermediário (E0264), e imunidade em produção (E0592, `tpImunidade`). Eles entram no contrato v2 (R-42). As regras conferidas no aceite estão em [NFSE-DPS](regras/NFSE-DPS.md).

Fonte de estrutura, enumerações e padrões: XSD oficiais da NFS-e Nacional, versionados com hash em `resources/fiscal/schemas/nfse-nacional/`:
- `1.01-20260209`: produção;
- `1.01-20261020-prodrest`: produção restrita.

Arquivos:
- `tiposComplexos_v1.01.xsd`: estrutura;
- `tiposSimples_v1.01.xsd`: tipos.

> Os **valores** são do contribuinte, ou do contador dele: opção do Simples, regime, códigos, alíquota, retenção e totais aproximados. O motor confere o formato e a enumeração contra o XSD, e não escolhe nada (ADR-0018).

| Campo da API | Elemento | Tipo no XSD | Obrigatório no contrato | Observação |
|---|---|---|---|---|
| `establishmentId` | (Id, `cLocEmi`, `prest/CNPJ`) | — | sim | O motor lê CNPJ e município do cadastro do estabelecimento |
| `seriesId` | `serie` | TSSerieDPS | não | Exigido quando há mais de uma série de DPS ativa no ambiente |
| `externalReference` | — | — | não | Referência do cliente (ADR-0026) |
| `competenceDate` | `dCompet` | TSData | sim | AAAA-MM-DD |
| `provider.simplesNacionalOption` | `prest/regTrib/opSimpNac` | TSOpSimpNac (1, 2, 3) | sim | 1 Não optante; 2 MEI; 3 ME/EPP |
| `provider.simplesNacionalRegime` | `prest/regTrib/regApTribSN` | TSRegimeApuracaoSimpNac (1, 2, 3) | não no XSD; **sim para ME/EPP** pelo roteamento (ADR-0028) | Sem ele, a ME/EPP é recusada com `ROUTE_REGIME_REQUIRED` |
| `provider.specialTaxRegime` | `prest/regTrib/regEspTrib` | TSRegEspTrib (0–6, 9) | sim | |
| `provider.municipalRegistration` | `prest/IM` | TSInscMun | não | |
| `taker.document` | `toma/CNPJ` ou `toma/CPF` | TSCNPJ / TSCPF | se houver tomador | NIF e cNaoNIF ainda fora (v2) |
| `taker.name` | `toma/xNome` | TSNomeRazaoSocial | se houver tomador | Obrigatório no pacote de produção; opcional no de produção restrita. O contrato exige nos dois |
| `taker.municipalRegistration` | `toma/IM` | TSInscMun | não | |
| `taker.email` | `toma/email` | TSEmail | não | |
| `service.municipalityCode` | `serv/locPrest/cLocPrestacao` | TSCodMunIBGE | sim | `cPaisPrestacao` (exterior) fica para a v2 |
| `service.nationalTaxCode` | `serv/cServ/cTribNac` | TSCodTribNac (6 dígitos) | sim | |
| `service.municipalTaxCode` | `serv/cServ/cTribMun` | TCCodTribMun (3 dígitos) | não | |
| `service.nbsCode` | `serv/cServ/cNBS` | TSCodNBS (9 dígitos) | não | |
| `service.description` | `serv/cServ/xDescServ` | TSDesc2000 | sim | Muda de posição conforme o pacote |
| `values.serviceAmount` | `valores/vServPrest/vServ` | TSDec15V2 | sim | Ponto decimal, 2 casas |
| `values.issqn.taxation` | `valores/trib/tribMun/tribISSQN` | TSTribISSQN (1–4) | sim | |
| `values.issqn.retention` | `valores/trib/tribMun/tpRetISSQN` | TSTipoRetISSQN (1–3) | sim | |
| `values.issqn.rate` | `valores/trib/tribMun/pAliq` | TSDec1V2 | não | |
| `values.approximateTaxes` (`AMOUNTS`) | `valores/trib/totTrib/vTotTrib` | TCTribTotalMonet | um dos quatro | Lei 12.741/2012 |
| `values.approximateTaxes` (`PERCENTAGES`) | `.../totTrib/pTotTrib` | TCTribTotalPercent | | |
| `values.approximateTaxes` (`SIMPLES_NACIONAL_RATE`) | `.../totTrib/pTotTribSN` | TSDec2V2 | | |
| `values.approximateTaxes` (`NOT_INFORMED`) | `.../totTrib/indTotTrib` = 0 | TSTipoIndTotTrib | | |

## Preenchidos pelo motor
| Elemento | Valor | Origem |
|---|---|---|
| `infDPS/@Id` | Regra do TSIdDPS | Documentação do tipo no XSD |
| `tpAmb` | 1 (credencial `live`) ou 2 (`test`) | TSTipoAmbiente |
| `dhEmi` | Horário de Brasília, `-03:00` | **Provisório** (ADR-0033 item 4) |
| `verAplic` | `orbita-nfe-<versão>` | TSVerAplic |
| `serie`, `nDPS` | Série e número alocados no aceite | ADR-0008 |
| `tpEmit` | 1 (Prestador) | TSEmitenteDPS |
| `finNFSe` | 0, só no pacote que exige | TSRTCFinNFSe (única enumeração) |
| `cLocEmi`, `prest/CNPJ` | Do estabelecimento | — |

## Diferenças entre os pacotes que o montador trata
- `finNFSe` existe e é obrigatório só no pacote de produção restrita.
- Ordem em `cServ`:
  - produção: `cTribNac`, `cTribMun`, `xDescServ`, `cNBS`;
  - produção restrita: `cTribNac`, `cTribMun`, `cNBS`, `xDescServ`.
- `toma/xNome`: obrigatório na produção; opcional na produção restrita.
- `TSSerieDPS` de produção precisa da errata XSD-ERRATA-001 (ADR-0013).
