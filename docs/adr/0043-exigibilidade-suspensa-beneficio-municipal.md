# ADR-0043 — Exigibilidade suspensa e benefício municipal na DPS

- Status: **Aceito** · Data: 2026-11-23
- Relacionados:
  - ADR-0018 (o motor não decide a tributação);
  - ADR-0037 (regras do Anexo I no aceite);
  - ADR-0042 (dedução da base, E0427).

## Contexto
Dois grupos do ISSQN ainda faltavam no contrato:
- a suspensão da exigibilidade por decisão judicial ou processo administrativo (`exigSusp`);
- o benefício municipal cadastrado pelo município no Sistema Nacional (`BM`).

## Fontes
XSD v1.01 dos dois pacotes, **iguais** nestes grupos:
- **`TCTribMunicipal`:** tribISSQN, cPaisResult?, tpImunidade?, **exigSusp?**, **BM?**, tpRetISSQN, pAliq?.
- **`TCExigSuspensa`:**
  - `tpSusp` (TSOpExigSuspensa: 1 decisão judicial, 2 processo administrativo);
  - `nProcesso` (`[0-9]{30}`).
- **`TCBeneficioMunicipal`:**
  - `nBM` (`[0-9]{14}`: IBGE do município, tipo de parametrização e sequencial gerado pelo Sistema Nacional);
  - choice opcional: `vRedBCBM` (TSDec15V2) | `pRedBCBM` (TSDec3V2).

Anexo I, aba "RN DPS_NFS-e", dos dois ambientes, com os mesmos textos e códigos nestas regras. Hashes em [fontes oficiais](../fiscal/fontes-oficiais.md).

## Decisão
1. **Contrato**, com acréscimos opcionais em `values.issqn`:
   - `suspension`: `{ type, processNumber }`;
   - `municipalBenefit`: `{ id, reduction? }`, com `reduction` igual a `{ kind: 'AMOUNT', amount }` ou `{ kind: 'PERCENTAGE', rate }`.
   - Os valores são do contribuinte. O tipo, a vigência e o limite do benefício são do cadastro do município, conferidos pelo autorizador.
2. **XML** na ordem de `TCTribMunicipal`: `exigSusp` e `BM` entre `tpImunidade` e `tpRetISSQN`. Validado nos dois XSD.
3. **Regras do aceite**, nos dois ambientes ([NFSE-DPS](../fiscal/regras/NFSE-DPS.md)):
   - **E0585:** suspensão só com `tribISSQN` 1.
   - **E0533:** benefício só com `tribISSQN` 1.
   - **E0534:** sem benefício para MEI.
   - **E0535:** sem benefício com `regEspTrib` diferente de 0. O texto lista 1 a 6 e 9.
   - **E0574:** `vRedBCBM` não pode ser maior que o valor do serviço.
     - O Anexo marca a regra como nível 3, mas o texto só depende da DPS, como na E0313.
   - **E0586, parcial:** `pRedBCBM` maior que 0.
     - O limite superior é o percentual parametrizado pelo município, então fica com o autorizador.
   - **E0427, ampliada:** a soma passa a incluir o `vRedBCBM`.
     - As reduções por percentual (`vCalcDR`, `vCalcBM`) são calculadas pelo autorizador e não entram na soma.
4. **Fora do aceite**, porque dependem do cadastro do benefício, da situação do convênio ou do ISSQN calculado:
   - E0536, E0537, E0541, E0544, E0548 e E0550;
   - E0565, E0567, E0577 e E0579;
   - E0575 e E0587;
   - E0439 e E0448 (dedução com benefício do tipo isenção).
5. **`cPaisResult` fica fora.** Ele é da exportação e entra junto com o tomador no exterior.

## Consequências
- Notas com exigibilidade suspensa e com benefício municipal passam a ser aceitas e montadas. O teste de ponta a ponta mostra os dois grupos no XML assinado, válido no XSD.
- Ficam para depois: tomador no exterior e exportação (endExt, NIF, `cPaisResult`, `comExt`), dedução por documentos e IBS/CBS.
