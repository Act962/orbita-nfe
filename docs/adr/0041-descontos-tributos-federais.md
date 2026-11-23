# ADR-0041 — Descontos e tributos federais na DPS

- Status: **Aceito** · Data: 2026-11-16
- Relacionados:
  - ADR-0018 (o motor não decide a tributação);
  - ADR-0037 (regras do Anexo I no aceite);
  - ADR-0040 (contrato v2);
  - R-42 e R-45.

## Contexto
Depois do contrato v2 ainda faltavam dois grupos de valores comuns em notas para empresas:
- descontos condicionado e incondicionado (`vDescCondIncond`);
- tributos federais (`tribFed`): PIS/COFINS de apuração própria e as retenções de CP, IRRF e CSLL.

Sem eles, a nota de um serviço com desconto ou com retenção federal não podia ser emitida pelo motor.

## Fontes
XSD v1.01, `tiposComplexos_v1.01.xsd`, nos dois pacotes:
- **`TCInfoValores`:** `vServPrest`, `vDescCondIncond?`, um grupo de dedução e `trib`.
- **`TCVDescCondIncond`:** `vDescIncond?` e `vDescCond?` (TSDec15V2).
- **`TCInfoTributacao`:** `tribMun`, `tribFed?`, `totTrib`.
- **`TCTribFederal`:** `piscofins?`, `vRetCP?`, `vRetIRRF?` e `vRetCSLL?`.
- **`TCTribOutrosPisCofins`:** `CST` (TSTipoCST, obrigatório), `vBCPisCofins?`, `pAliqPis?`, `pAliqCofins?` (TSDec2V2), `vPis?`, `vCofins?` e `tpRetPisCofins?` (TSTipoRetPISCofins, de 0 a 9).

Esses grupos são **iguais** nos dois pacotes, produção (09/02/2026) e produção restrita (20/10/2026).

O grupo de dedução **não é igual**:
- na produção, é o `vDedRed` (`pDR` | `vDR` | `documentos`);
- na produção restrita, é o `vAjusteBC` (`pAjusteBCISSQN` | `vAjusteBCISSQN`, mais `documentos` com outro tipo).

Regras do Anexo I, aba "RN DPS_NFS-e", dos dois ambientes (hashes em [fontes oficiais](../fiscal/fontes-oficiais.md)).

## Decisão
1. **Acréscimos opcionais na API v1**, como no ADR-0040:
   - `values.discounts`: `unconditional` (vDescIncond) e `conditional` (vDescCond), com ao menos um;
   - `values.federalTaxes`:
     - `pisCofins`: `cst`, `baseAmount`, `pisRate`, `cofinsRate`, `pisAmount`, `cofinsAmount` e `retentionType`;
     - `socialSecurityWithheld` (vRetCP), `incomeTaxWithheld` (vRetIRRF) e `contributionsWithheld` (vRetCSLL), com ao menos um campo.
   - Todos os valores, inclusive o CST e o tipo de retenção, são do contribuinte. O motor não calcula nem escolhe nenhum (ADR-0018).
2. **XML** na ordem do XSD: `vDescCondIncond` entre `vServPrest` e `trib`; `tribFed` entre `tribMun` e `totTrib`. Validado nos dois XSD.
3. **Regras do aceite**, nos dois ambientes ([NFSE-DPS](../fiscal/regras/NFSE-DPS.md)):
   - **E0431 / E0432:** cada desconto deve ser maior que zero e menor que o valor do serviço.
   - **E0699 / E0700 / E0701:** vRetCP, vRetIRRF e vRetCSLL, quando informados, devem ser maiores que zero e menores que o valor do serviço.
   - **E0720:** com `tpRetPisCofins` 0, o vRetCSLL não pode ser informado.
   - **E0724:** com `tpRetPisCofins` diferente de 0 e de 2, o vRetCSLL é obrigatório.
   - **E0428, conferência parcial:** a regra pede valor do serviço ≥ descontos + CP + IRRF + CSLL + ISSQN retido.
     - O ISSQN retido é calculado pelo autorizador e não está na DPS, por isso o motor confere a soma sem ele.
     - Assim, o motor só recusa o que o autorizador também recusaria. O caso com ISSQN retido no limite continua com o autorizador.
4. **Fora do aceite**, com o autorizador (motivo no catálogo):
   - **E0694 / E0696** (vPis e vCofins iguais a base × alíquota): o Anexo não define o arredondamento.
   - **E0676 / E0677:** a coluna de efeito traz "Obrig." em vez de "Rej.", e a E0676 depende do cadastro do MEI.
   - **E0686 / E0692** (alíquotas entre 0 e 100%): o formato TSDec2V2 já limita a 99,99.
   - **E0427:** a parte que depende da DPS (desconto incondicionado ≤ serviço) já é coberta pela E0431, que é mais estrita.
5. **Deduções ficam para uma etapa própria.** O grupo muda de nome e de forma entre os pacotes. É preciso decidir como o contrato representa a dedução nos dois e como fica a passagem quando a produção adotar o pacote novo (R-45).

## Consequências
- Notas com desconto e com retenções federais passam a ser aceitas e montadas. O teste de ponta a ponta mostra a nota aceita, transmitida ao simulador e válida no XSD.
- Quem já integra não muda nada: os campos novos são opcionais.
- Ficam para depois: deduções (R-45), tomador no exterior, benefício municipal, exigibilidade suspensa e IBS/CBS.
