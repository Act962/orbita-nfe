# ADR-0040 — Contrato v2 da DPS: endereço, intermediário e imunidade

- Status: **Aceito** · Data: 2026-11-16
- Relacionados:
  - ADR-0033 (contrato v1);
  - ADR-0037 (regras do Anexo I no aceite);
  - R-42.

## Contexto
O contrato v1 não tinha três grupos que o Anexo I exige (ADR-0037):
- **E0235:** tomador com CNPJ exige o endereço nacional do tomador;
- **E0237:** retenção pelo tomador exige o endereço;
- **E0264:** retenção pelo intermediário exige o intermediário;
- **E0592** (produção): imunidade exige `tpImunidade`.

Esses casos eram recusados no aceite. Na prática, notas para empresas (B2B) e com retenção ficavam bloqueadas.

## Fontes
XSD v1.01. Os dois pacotes, produção (09/02/2026) e produção restrita (20/10/2026), são iguais nestes grupos. A única diferença é que o `xNome` de `TCInfoPessoa` é opcional na produção restrita; o contrato sempre o exige.
- **`TCInfoPessoa`:** CNPJ|CPF|NIF|cNaoNIF, CAEPF?, IM?, xNome, end?, fone?, email?.
- **`TCEndereco`:** escolha entre `endNac` (`cMun` TSCodMunIBGE e `CEP` TSCEP `[0-9]{8}`) e `endExt`, seguida de `xLgr` (1–255), `nro` (1–60), `xCpl?` (1–156) e `xBairro` (1–60).
- **`TSTelefone`:** `[0-9]{6,20}`.
- **`TCInfDPS`:** o `interm` (`TCInfoPessoa`, 0..1) vem logo depois de `toma`.
- **`TCTribMunicipal`:** tribISSQN, cPaisResult?, **tpImunidade?**, exigSusp?, BM?, tpRetISSQN, pAliq?.
  - `TSTipoImunidadeISSQN` vai de 0 a 5. O 0 é "tipo não informado na nota de origem"; de 1 a 5 são as alíneas a a e do art. 150, VI, da CF88.

## Decisão
1. **Acréscimos opcionais, sem quebrar o v1.** A API continua `/v1`, porque quem já integra não precisa mudar nada. Entram:
   - `taker.address` e `taker.phone`;
   - `intermediary`, com a mesma forma do tomador;
   - `values.issqn.immunityType`.
   - Os valores são do contribuinte; o motor não escolhe nenhum (ADR-0018).
2. **Só endereço nacional (`endNac`).** O `endExt` e a identificação por NIF ou `cNaoNIF` exigem regras de exterior (E0223, E0242, E0246) e ficam para depois.
3. **XML** na ordem do XSD. A função `party` monta o tomador e o intermediário. O grupo `end` traz `endNac`, `xLgr`, `nro`, `xCpl` e `xBairro`. O `tpImunidade` fica entre `tribISSQN` e `tpRetISSQN`. Validado nos dois XSD.
4. **Regras do aceite atualizadas** ([NFSE-DPS](../fiscal/regras/NFSE-DPS.md)):
   - **E0235:** recusa só tomador com CNPJ **sem** endereço.
   - **E0237:** recusa só retenção pelo tomador com tomador **sem** endereço. Sem tomador nenhum, quem recusa é a E0204.
   - **E0264:** recusa só retenção pelo intermediário **sem** intermediário.
   - **E0592** (produção): `tpImunidade` obrigatório com `tribISSQN` 2, **e só** com ele.
   - **Novas:**
     - **E0248:** DV do CNPJ do intermediário;
     - **E0262:** a raiz do CNPJ do intermediário não pode ser a do prestador, comparando 8 posições como o texto da produção restrita;
     - **E0593:** `tpImunidade` 0 não é permitido na DPS.
5. **Fora do aceite**, com o autorizador:
   - existência do município (E0238);
   - CEP do município (E0240, E0653);
   - endereço exigido pela tabela de incidência (E0234, E0241).

## Consequências
- A emissão para tomador com CNPJ (B2B), com retenção do ISSQN e com imunidade deixa de ser recusada pelo contrato. **R-42 fica mitigado.**
- O teste de ponta a ponta mostra a nota B2B com retenção aceita, montada e válida no XSD.
- Ficam para depois:
  - tomador no exterior;
  - deduções e descontos;
  - benefício municipal;
  - exigibilidade suspensa;
  - grupo IBS/CBS, obrigatório para o Simples a partir de 2027 e com leiaute ainda pendente (NT 009).
