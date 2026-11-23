# ADR-0045 — Prestação do serviço no exterior e cNBS na exportação

- Status: **Aceito** · Data: 2026-11-23
- Relacionados:
  - ADR-0044 (tomador no exterior e exportação);
  - ADR-0037 (regras do Anexo I no aceite).

## Contexto
O ADR-0044 deixou de fora o local da prestação no exterior (`cPaisPrestacao`). Ao lê-lo, apareceu a **E0318**, que faltava no ADR-0044: com tomador ou intermediário no exterior, ou com prestação no exterior, o código NBS (`cNBS`) é obrigatório.

## Fontes
- XSD v1.01 dos dois pacotes, iguais: `TCLocPrest` é um choice entre `cLocPrestacao` (TSCodMunIBGE) e `cPaisPrestacao` (TSCodPaisISO).
- Anexo I, aba "RN DPS_NFS-e", dos dois ambientes, com o mesmo texto:
  - **E0304:** país existente na tabela ISO2 e diferente de BR;
  - **E0318:** tomador ou intermediário no exterior, ou `cPaisPrestacao`, exigem um item da NBS (com `tpEmit` 1);
  - **E0330:** `cPaisPrestacao` também exige `comExt`.
- A **E0934** também cita o `cPaisPrestacao`, mas é do grupo IBS/CBS de imóvel, que não existe no contrato.

## Decisão
1. **Contrato:** `service.countryCode` (cPaisPrestacao) como alternativa a `service.municipalityCode`.
   - O aceite exige exatamente um dos dois, como o choice do XSD; sem nenhum ou com os dois, responde 400.
   - Quem já integra continua mandando só o `municipalityCode`.
2. **XML:** `locPrest` traz o elemento informado. Validado nos dois XSD.
3. **Regras do aceite**, nos dois ambientes:
   - **E0304, parcial:** país ≠ BR. A existência do código na tabela fica com o autorizador.
   - **E0318:** `cNBS` obrigatório com tomador ou intermediário no exterior, ou com prestação no exterior.
   - **E0330:** passa a ter os três gatilhos do texto: tomador no exterior, intermediário no exterior e `cPaisPrestacao`, além da exportação.
4. **Substituição:** a trava do local da prestação (E0059 a E0064) cita só o `cLocPrestacao`. Com isso, a troca entre município e país conta como alteração; a troca de um país por outro não, porque o texto não a cita.

## Consequências
- A prestação no exterior passa a ser aceita e montada.
- **Mudança de comportamento (correção da E0318):** a DPS com tomador ou intermediário no exterior sem `nbsCode` passa a ser recusada no aceite, em vez de ser rejeitada pelo autorizador.
