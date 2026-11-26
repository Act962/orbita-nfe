# ADR-0071 — Perfil estadual do estabelecimento (inscrição estadual, CRT e endereço do emitente)

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0061 (inscrição municipal, mesmo padrão de cadastro);
  - ADR-0069 (contrato da NFC-e: "o emitente sai do cadastro, nunca do pedido");
  - roadmap, Fase 3: "Inscrição estadual por estabelecimento".

## Contexto
O grupo `emit` da NF-e/NFC-e (`TNFe` do PL_010h) exige do emitente:
- CNPJ e razão social;
- endereço completo (`TEnderEmi`);
- inscrição estadual (`TIe`);
- regime tributário (`CRT`).

O cadastro do estabelecimento só tinha CNPJ, nome fantasia, município e inscrição municipal. O ADR-0069 fixou que esses dados vêm do cadastro, não do pedido, e que o motor não os escolhe.

## Decisão
1. **Perfil estadual no estabelecimento** (`stateProfile`), opcional e tudo ou nada:
   - `stateRegistration`: `TIe`, de 2 a 14 dígitos ou `ISENTO`. Pontuação é recusada, não removida.
   - `taxRegime`: `CRT`, a enumeração do XSD (1, 2, 3 ou 4). Informado pelo contador e nunca deduzido.
   - `address`: `TEnderEmi`.
     - `street` (2 a 60), `number` (1 a 60), `complement` (opcional, 1 a 60) e `district` (2 a 60);
     - `postalCode`: 8 dígitos, aceita hífen e é normalizado;
     - `phone`: opcional, de 6 a 14 dígitos, aceita máscara e é normalizado.
2. **Rotas**, com o escopo `companies:manage` e auditoria `establishment.state_profile_changed`:
   - `PUT /v1/establishments/{id}/state-profile` grava o perfil inteiro;
   - `DELETE` apaga;
   - a consulta do estabelecimento devolve `stateProfile`, ou `null`.
   - Repetir o mesmo perfil não gera auditoria.
   - Campo desconhecido no corpo é recusado.
   - As duas rotas entraram na matriz de isolamento: de outra empresa, a resposta é `404`.
3. **O que não fica no perfil:**
   - **o município:** já é o do estabelecimento;
   - **o nome do município (`xMun`) e a UF:** saem da tabela oficial do IBGE (ADR-0058), pelo código do município, na montagem da nota;
   - **a razão social:** é a da empresa.
4. **Banco (migration 0037):**
   - colunas no próprio `establishments`, que já tem RLS e permissões;
   - a constraint `ck_establishments_state_profile_complete` recusa perfil pela metade, mesmo fora da API;
   - checks com os mesmos formatos (`TIe`, CRT, CEP, fone).
5. **Sem perfil, o estabelecimento não emite NFC-e.** Isso entra no aceite da emissão, na próxima fatia.

## Consequências
- O emitente da NFC-e passa a ter fonte única e auditada.
- O dígito verificador da inscrição estadual não é conferido. A regra é de cada UF, e não temos a do Piauí de fonte oficial. Quem confere é a SEFAZ.
- Para NF-e de outras UFs, o mesmo perfil serve. Um estabelecimento com inscrição em mais de uma UF (substituto tributário, `IEST`) fica para quando houver o caso.
