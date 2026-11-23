# NFSE-DPS — Regras do Anexo I conferidas no aceite da DPS (NFS-e Padrão Nacional)

- Implementação: `src/modules/nfse/domain/dps-rules.ts` (`checkDpsRules`, versão `anexo-i-v1.01-20260209+20261020`)
- Testes: `dps-rules.test.ts` (cada regra violada e não violada, por ambiente) e `test/integration/nfse-api.test.ts`
- Decisão: [ADR-0037](../../adr/0037-regras-anexo-i-no-aceite.md)
- Status: **conferida contra os dois Anexos I em 2026-11-13**. Revisão do especialista fiscal pendente (gate fiscal 1).

## Fontes oficiais
Anexo I, aba "RN DPS_NFS-e", registrados em [fontes oficiais](../fontes-oficiais.md):

| Ambiente do motor | Anexo | SHA-256 |
|---|---|---|
| `PRODUCTION` | produção, v1.01 de 09/02/2026 | `de5bc492959eadc8bfa7540e16939995924f2188f743648eaf84d3b31e9eeb7c` |
| `HOMOLOGATION` (produção restrita) | produção restrita, v1.01 de 20/10/2026 | `72b05981c8882cdd807f3acf901b669465360f9cf1b9d9e235ac4363dacfb2d8` |

## Critério de entrada
Uma regra só entra quando cumpre as três condições:
1. É de nível 1 ou 2 no Anexo (consistência do leiaute ou regra geral).
2. Depende **só** de dados da DPS do contrato v1. Ficam de fora as que consultam cadastro (CNPJ, CPF, CNC, Simples Nacional), a parametrização do município ou tabelas que o motor não tem (lista de serviços, NBS, cenários de exportação).
3. O texto é claro no Anexo do ambiente. Quando os dois textos diferem, cada ambiente segue o seu.

O emitente é sempre o prestador (`tpEmit = 1`), então as regras dos casos `tpEmit = 2` ou `3` não se aplicam.

## Regras implementadas
O código da regra é o código de rejeição do Anexo. Na API, cada violação é um item de `issues[]`, com `code` (o código), `field` (o campo do contrato) e `ruleId: "NFSE-DPS"`.

| Código | Ambientes | Nível | Regra (resumo do texto oficial) | Campo |
|---|---|---|---|---|
| E0015 | os dois | 1 | `dCompet` ≤ data de `dhEmi` (o motor usa a data de hoje em UTC−03:00, o fuso do `dhEmi`) | `competenceDate` |
| E0162 | os dois | 2 | `regApTribSN` não pode ser informado com `opSimpNac` 1 ou 2 | `provider.simplesNacionalRegime` |
| E0166 | os dois | 2 | `regApTribSN` obrigatório com `opSimpNac` 3 | `provider.simplesNacionalRegime` |
| E0172 | os dois | 2 | `tribISSQN` 2, 3 ou 4 → `regEspTrib` = 0 | `provider.specialTaxRegime` |
| E0174 | os dois | 2 | MEI → `regEspTrib` = 0 | `provider.specialTaxRegime` |
| E0175 | os dois | 2 | `opSimpNac` 3 e `regApTribSN` 1 → `regEspTrib` = 0 | `provider.specialTaxRegime` |
| E0188 | os dois | 1 | CNPJ do tomador com DV inválido ([CNPJ-001](CNPJ-001.md)) | `taker.document` |
| E0202 | os dois | 2 | CNPJ do tomador igual ao do prestador (CNPJ completo) | `taker.document` |
| E0204 | os dois | 2 | `tpRetISSQN` 2 → tomador identificado por CNPJ ou CPF | `taker` |
| E0235 | os dois | 1 | Tomador por CNPJ (com `tpEmit` 1) → `toma/end/endNac` obrigatório | `taker.address` |
| E0237 | os dois | 1 | `tpRetISSQN` 2 → `toma/end/endNac` obrigatório | `taker.address` |
| E0248 | os dois | 1 | CNPJ do intermediário com DV inválido (v2) | `intermediary.document` |
| E0262 | os dois | 2 | Raiz do CNPJ do intermediário igual à do prestador, 8 posições (v2) | `intermediary.document` |
| E0264 | os dois | 2 | `tpRetISSQN` 3 → intermediário identificado por CNPJ ou CPF | `intermediary` |
| E1402 | os dois | — | `cTribNac` 200101 → `cLocPrestacao` não pode ser 0000000 | `service.municipalityCode` |
| E0309 | produção restrita | 1 | `cTribNac` 99.03.xx ou 99.04.01 é rejeitado (só existe nesse Anexo) | `service.nationalTaxCode` |
| E0313 | produção restrita | 3* | MEI não informa `cTribMun` (só existe nesse Anexo) | `service.municipalTaxCode` |
| E0315 | os dois | 1 | `cTribMun` não pode ser 000 | `service.municipalTaxCode` |
| E0532 | produção | 2 | `cTribNac` 990101 → `tribISSQN` = 4 | `values.issqn.taxation` |
| E0532 | produção restrita | 2 | `cTribNac` 99.XX.XX → `tribISSQN` = 4 | `values.issqn.taxation` |
| E0592 | produção | 2 | `tpImunidade` obrigatório e informado **somente** com `tribISSQN` 2 | `values.issqn.immunityType` |
| E0593 | os dois | 2 | `tpImunidade` 0 ("não informado na nota de origem") não é permitido na DPS | `values.issqn.immunityType` |
| E0585 | os dois | 2 | Exigibilidade suspensa só com `tribISSQN` 1 (ADR-0043) | `values.issqn.suspension` |
| E0533 | os dois | 2 | Benefício municipal só com `tribISSQN` 1 | `values.issqn.municipalBenefit` |
| E0534 | os dois | 2 | MEI → sem benefício municipal | `values.issqn.municipalBenefit` |
| E0535 | os dois | 2 | `regEspTrib` ≠ 0 → sem benefício municipal | `values.issqn.municipalBenefit` |
| E0574 | os dois | 3* | `vRedBCBM` ≤ `vServ` | `values.issqn.municipalBenefit.reduction.amount` |
| E0586 | os dois | 3* | `pRedBCBM` > 0. **Parcial:** o limite superior é parametrizado pelo município | `values.issqn.municipalBenefit.reduction.rate` |
| E0580 | os dois | 2 | `tribISSQN` 2, 3 ou 4 → `tpRetISSQN` = 1 | `values.issqn.retention` |
| E0583 | os dois | 2 | MEI → `tpRetISSQN` = 1 | `values.issqn.retention` |
| E0588 | os dois | 2 | `regEspTrib` ≠ 0 → `tpRetISSQN` = 1 | `values.issqn.retention` |
| E0596 | produção | 2 | `cTribNac` 220101 → `tpRetISSQN` = 1 (ausente no Anexo da produção restrita) | `values.issqn.retention` |
| E0595 | os dois | 2 | `pAliq` ≤ 5% | `values.issqn.rate` |
| E0600 | os dois | 2 | MEI não informa `pAliq` | `values.issqn.rate` |
| E0602 | os dois | 2 | `tribISSQN` 2, 3 ou 4 → sem `pAliq` | `values.issqn.rate` |
| E0604 | os dois | 2 | `regEspTrib` ≠ 0 → sem `pAliq` | `values.issqn.rate` |
| E0427 | os dois | 2 | `vServ` ≥ `vDescIncond` + valor da dedução (`vDR` ou `vAjusteBCISSQN`) + `vRedBCBM` (ADR-0042, ADR-0043). As reduções por percentual são calculadas pelo autorizador e não entram | `values` |
| E0435 | os dois | 2 | `tribISSQN` 2, 3 ou 4 → sem dedução. O texto da produção termina com "ou seja, tpRetISSQN tem que ser igual a 1", em contradição com a condição e a mensagem; vale a condição, igual à da produção restrita | `values.deduction` |
| E0436 | os dois | 2 | MEI → sem dedução | `values.deduction` |
| E0438 | produção | 2 | `regEspTrib` ≠ 0 → sem dedução | `values.deduction` |
| E0445 | produção restrita | 2 | `regEspTrib` de 1 a 6 → sem ajuste da BC (o texto não lista o 9) | `values.deduction` |
| E0453 | os dois | 1 | Percentual de dedução (`pDR` ou `pAjusteBCISSQN`) > 0 e ≤ 100% | `values.deduction.rate` |
| E0428 | os dois | 2 | `vServ` ≥ `vDescIncond` + `vDescCond` + `vRetCP` + `vRetIRRF` + `vRetCSLL` (+ ISSQN retido). **Parcial:** o ISSQN retido é calculado pelo autorizador e fica fora da soma, então o motor só recusa o que o autorizador também recusaria (ADR-0041) | `values` |
| E0431 | os dois | 2 | `vDescIncond` > 0 e < `vServ` | `values.discounts.unconditional` |
| E0432 | os dois | 2 | `vDescCond` > 0 e < `vServ` | `values.discounts.conditional` |
| E0699 | os dois | 1 | `vRetCP`, se informado, > 0 e < `vServ` | `values.federalTaxes.socialSecurityWithheld` |
| E0700 | os dois | 1 | `vRetIRRF`, se informado, > 0 e < `vServ` | `values.federalTaxes.incomeTaxWithheld` |
| E0701 | os dois | 1 | `vRetCSLL`, se informado, > 0 e < `vServ` | `values.federalTaxes.contributionsWithheld` |
| E0720 | os dois | 1 | `tpRetPisCofins` 0 → sem `vRetCSLL` | `values.federalTaxes.contributionsWithheld` |
| E0724 | os dois | 1 | `tpRetPisCofins` diferente de 0 e de 2 → `vRetCSLL` obrigatório | `values.federalTaxes.contributionsWithheld` |
| E0702–E0704 | os dois | 1 | `vTotTribFed`, `vTotTribEst`, `vTotTribMun` ≤ `vServ` | `values.approximateTaxes.*` |
| E0706–E0708 | os dois | 1 | `pTotTribFed`, `pTotTribEst`, `pTotTribMun` ≤ 100% | `values.approximateTaxes.*` |
| E0710 | os dois | 1 | MEI não informa `pTotTribSN` | `values.approximateTaxes` |
| E0712 | os dois | 1 | ME/EPP não informa `indTotTrib` | `values.approximateTaxes` |
| E0713 | os dois | 1 | Não optante não informa `indTotTrib` nem `pTotTribSN` | `values.approximateTaxes` |

\* A E0313, a E0574 e a parte conferida da E0586 estão marcadas como nível 3 no Anexo, mas o texto conferido não depende de parametrização: só de campos da DPS.

Os limites são inclusivos: competência igual a hoje, alíquota de 5,00% e total igual ao valor do serviço passam.

## Lacunas do contrato v1 (achado; resolvidas no v2, [ADR-0040](../../adr/0040-contrato-dps-v2.md))
Quatro regras não têm como ser cumpridas com o contrato v1, porque o grupo exigido não existe nele:
- **E0235:** tomador identificado por CNPJ exige o endereço nacional do tomador;
- **E0237:** retenção pelo tomador exige o mesmo endereço;
- **E0264:** retenção pelo intermediário exige o grupo `interm`;
- **E0592** (produção): imunidade exige `tpImunidade`.

Antes destas regras, o motor aceitava esses casos e o autorizador os rejeitaria. Agora a recusa é local, antes de numerar, e a mensagem diz que o caso depende do contrato v2. Hoje só se emite sem tomador ou com tomador por CPF, sem retenção, e com tributação diferente de imunidade. Isso não é decisão fiscal: é o que a fonte exige e o contrato ainda não leva.

## Fora do catálogo (com o motivo)
| Regras | Motivo |
|---|---|
| E0016, E0018, E0020, E0023, E0025, E1270 | Datas de cadastro e de convênio que o motor não tem |
| E0082, E0084, E0098, E0116–E0124, E0160, E0190, E0207 | Cadastro CNPJ, CPF, CNC ou Simples Nacional |
| E0206 (DV do CPF) | O Anexo só diz "verificar DV". O algoritmo ainda não tem fonte registrada no projeto. Entra com a regra CPF-001 |
| E0247 (e-mail) | O texto ("conter @, ponto etc.") não define a regra |
| E0310, E0312, E0314, E0316, E0529, E0530, E0539, E0540 | Lista de serviços, NBS, cenários de exportação ou parametrização do município |
| E0440, E0441, E0442 (produção); E0449–E0452, E0455 (produção restrita) | Dedução conforme a situação do convênio e a parametrização do código de serviço no município |
| E0444, E0447 | Alíquota efetiva mínima de 2%: depende do ISSQN calculado pelo autorizador |
| E0439, E0448 | Dependem do tipo do benefício municipal (isenção), que é do cadastro do município |
| E0536, E0537, E0541, E0544, E0548, E0550, E0565, E0567, E0577, E0579 | Cadastro do benefício municipal (existência, tipo, vigência, prestadores) ou situação do convênio |
| E0575, E0587 | Alíquota efetiva mínima de 2% com benefício: depende do ISSQN calculado |
| E0437, E0446, E0449 (produção), E0454, E0462, E0463 | Dedução por documentos (fora do contrato) ou parametrização do município |
| E0694, E0696 | `vPis` e `vCofins` iguais a base × alíquota: o Anexo não define o arredondamento |
| E0676, E0677 | A coluna de efeito traz "Obrig." em vez de "Rej."; a E0676 ainda depende do cadastro do MEI |
| E0686, E0692 | Alíquota do PIS e da COFINS entre 0 e 100%: o formato TSDec2V2 já limita a 99,99 |
| E0612–E0640 (`pAliq` por convênio) | Dependem da situação do convênio do município de incidência e de benefício municipal |
| E0655–E0665 | Regras de retenção parametrizadas pelo município |
| E0008, E1294 | `dhEmi` é montado pelo motor no momento do envio |

## Pendências
- Revisão pelo especialista fiscal (gate fiscal 1).
- Ao trocar o pacote de produção, repetir o confronto entre os Anexos e ajustar os ambientes de cada regra.
- CPF-001 (DV do CPF) com fonte, para ligar a E0206.
