# ADR-0036 — Substituição de NFS-e (DPS com o grupo `subst`)

- Status: **Aceito** · Data: 2026-11-13
- Relacionados:
  - ADR-0007 (idempotência);
  - ADR-0026 (referência externa);
  - ADR-0028 (canal gravado);
  - ADR-0032 (núcleo da emissão);
  - ADR-0034 (resolução manual);
  - ADR-0035 (cancelamento).

## Contexto
No padrão nacional, substituir uma NFS-e é emitir uma DPS nova com o grupo `subst`, que aponta para a nota substituída. Quem gera o evento e105102 ("Cancelamento de NFS-e por Substituição") na nota original é o próprio autorizador. O emitente não envia evento nenhum.

Fontes, conferidas nesta data:
- **XSD v1.01, iguais nos dois pacotes** (produção de 09/02/2026 e produção restrita de 20/10/2026):
  - `TCInfDPS/subst` (0..1), depois de `cLocEmi` e antes de `prest`;
  - `TCSubstituicao`, com três campos:
    - `chSubstda` (TSChaveNFSe);
    - `cMotivo` (TSCodJustSubst, enumeração `01` a `05` e `99`);
    - `xMotivo` (TSMotivo, de 15 a 255 caracteres, opcional);
  - `TE105102`: `xDesc`, `cMotivo`, `xMotivo` e `chSubstituta`, "obtidos do campo da DPS".
- **Anexo I v1.01, os dois**, registrados em [fontes oficiais](../fiscal/fontes-oficiais.md) e baixados de novo nesta data com o mesmo SHA-256:
  - produção (09/02/2026), `de5bc492…eeb7c`;
  - produção restrita (20/10/2026), `72b05981…2dd8`.
  - Aba LEIAUTE: `chSubstda` (o município parametriza o prazo, até 2 anos, e se exige tomador identificado); `xMotivo` para o motivo 99.
  - Aba RN DPS_NFS-e: E0042, E0044, E0046, E0050, E0056, E0058, E0065, E0068, E0070, E0072, E0074, E0076, E0078, E1308 e E1310, com o mesmo texto nos dois. Os campos travados **mudaram** de um para o outro (item 4).
- **Guia V7 §3.1** (Teresina, emissor municipal): "DPS com a chave a substituir", que gera o cancelamento por substituição da original. Registrado em [nfse-teresina-api-municipal-x-nacional](../fiscal/nfse-teresina-api-municipal-x-nacional.md).

## Decisão
1. **Contrato.** `POST /v1/service-invoices/{id}/substitution`, escopo `nfse:issue`, com `Idempotency-Key` obrigatório.
   - O corpo é o contrato v1 da DPS ([ADR-0033](0033-contrato-dps-v1.md)) sem `establishmentId`, mais `substitution: { reasonCode, reasonText? }`.
   - **O motivo é do contribuinte**; o motor não escolhe nem sugere.
   - A resposta é a **substituta**, com `202 PENDING` e `Location`. A mesma chave com o mesmo corpo devolve `200`.
   - A resposta da nota ganhou `substitution` (na substituta) e `substitutedById` (na original).
2. **A substituta é uma NFS-e comum** com quatro colunas imutáveis: original, `chSubstda`, `cMotivo` e `xMotivo`.
   - Tem número próprio na série, roteamento pela própria competência e o mesmo write-ahead, `UNKNOWN` e reconciliação da emissão.
   - Sai do **mesmo estabelecimento** da original. A E0042 exige que município, tipo de inscrição e inscrição da chave batam com o Id da DPS.
   - Sai do mesmo ambiente e da mesma aplicação. O canal das duas é `NATIONAL_SEFIN`, por causa da E0065 (mesmo ambiente gerador).
3. **Exclusão mútua com o cancelamento.**
   - Pedidos sobre a mesma original (substituição e cancelamento) são serializados por uma trava consultiva da transação (`pg_advisory_xact_lock`), que não exige privilégio de UPDATE na nota.
   - Uma substituta "viva" (fora de `REJECTED` ou `FAILED`) por original, garantida por índice único parcial.
   - Substituição com cancelamento ativo → `409 CANCELLATION_IN_PROGRESS`.
   - Cancelamento com substituta viva → `409 SUBSTITUTION_IN_PROGRESS`.
   - **Substituta em `UNKNOWN` não libera outra**: a dúvida nunca vira duas substitutas.
4. **Pré-validações locais** (antes de numerar, com a fonte de cada uma):
   - original `AUTHORIZED`, conferido localmente (E0046 cobre a cancelada; uma nota `SUBSTITUTED` também é recusada);
   - **E0078** (nível 1): motivo `99` exige `xMotivo` → `400`;
   - **Campos travados** (nível 2) → `422 SUBSTITUTION_LOCKED_FIELDS`, campo a campo em `issues`, com o código do Anexo I do pacote do ambiente.
     - A produção restrita traz uma matriz explícita pela opção pelo Simples da original e da substituta "na data de competência da nota substituta":

       | Original → substituta | Código | Campos travados |
       |---|---|---|
       | 1 → 1 | E0059 | `dCompet`, `cTribNac`, `cTribMun`, `cLocPrestacao` |
       | 1 → 2 ou 3 | E0060 | `dCompet`, tomador (CPF/CNPJ/NIF, "se identificado na DPS da nota original"), `vServ` |
       | 2 → 2 ou 3 | E0061 | idem |
       | 2 → 1 | E0062 | `dCompet`, `cTribNac`, `cLocPrestacao` |
       | 3 → 3 ou 2 | E0063 | `dCompet`, tomador, `vServ` |
       | 3 → 1 | E0064 | `dCompet`, `cTribNac`, `cTribMun`, `cLocPrestacao` |

     - A produção tem só a E0060 (não optante: competência, "subitem da lista nacional", código municipal e local) e a E0061 (MEI ou ME/EPP: tomador "se identificado na DPS", `dCompet` e `vServ`), sem dizer de qual nota é a opção. Lida pela opção da **substituta** (a DPS validada), dá os mesmos campos da matriz, que confirma a leitura. A matriz também diz que "subitem" é o `cTribNac`.
     - **Na dúvida, o motor trava a menos.** Na E0062, o texto da regra não lista o `cTribMun`, mas a mensagem lista; o motor não o trava. Trava a mais recusaria uma substituição válida; trava a menos só deixa a decisão para o autorizador.
   - O resto é do autorizador, e a rejeição chega ao cliente.
5. **Fechamento.** Quando a substituta vira `AUTHORIZED`, na **mesma transação**, a original vai de `AUTHORIZED` para `SUBSTITUTED`, com `substituted_by_invoice_id`, auditoria e webhook.
   - Vale nos três caminhos: resposta do envio, consulta e resolução manual.
   - Antes disso a original não muda. Se a substituta for rejeitada, a original segue `AUTHORIZED` e aceita nova substituição.
   - O fechamento nunca desfaz a autorização da substituta. Se a original não estiver mais `AUTHORIZED`, registra `service_invoice.substitution_unlinked` na auditoria. Isso não deveria acontecer, por causa do item 3.
6. **Banco**, como defesa em profundidade (migrations 0019 e 0020):
   - CHECK das colunas e do código (enumeração do XSD), e motivo 99 com texto;
   - FK composta pela empresa;
   - trigger no INSERT da substituta (original `AUTHORIZED`, canal, estabelecimento, ambiente, aplicação, chave igual, sem cancelamento ativo) e o inverso no INSERT do cancelamento;
   - guarda: colunas imutáveis, vínculo gravado uma vez, e `SUBSTITUTED` só com uma substituta `AUTHORIZED` que aponte para a nota;
   - grants mínimos: a API insere as colunas, o worker grava o vínculo e o operador vê os identificadores.
7. **Regras do Anexo I e onde ficam:**

   | Regra | Nível | O que diz | Onde |
   |---|---|---|---|
   | E0042 | 1 | Chave válida e coerente com o Id da DPS | Mesmo estabelecimento (item 2); a chave vem da original |
   | E0044 | 1 | NFS-e inexistente | A chave vem de uma nota autorizada no motor |
   | E0046 | 1 | Cancelada não pode ser substituída | Local (status) e autorizador |
   | E0050 | 3 | Prazo do município (exceto motivos 1 e 2) | Autorizador: o prazo não é conhecido |
   | E0056, E0058 | 3 | Tomador ausente ou não emitente alterado, conforme o município | Autorizador |
   | E0059 a E0064 (produção restrita), E0060 e E0061 (produção) | 2 | Campos travados conforme a opção pelo Simples | **Local** (item 4) e autorizador |
   | E0065 | 1 | Mesmo ambiente gerador | Canal `NATIONAL_SEFIN` nas duas |
   | E0068 a E0076 | 1–3 | Análise fiscal, manifestação, tributos recolhidos, bloqueio de ofício | Autorizador: eventos de terceiros |
   | E0078 | 1 | Motivo 99 exige `xMotivo` | **Local** (item 4) e banco |
   | E1308, E1310 | 1 | Compartilhamento com o ADN | Não se aplicam: são do município que compartilha |

   Em Teresina, o não optante nem sai pelo canal nacional (ADR-0028). As regras para a substituta não optante existem no motor, mas hoje só valem em outro município.
8. **Divergência de fonte.** O leiaute do Anexo I de produção escreve `cMotivo` com 1 posição ("1 - …"), mas o XSD exige `01`. O leiaute da produção restrita já escreve 2 posições ("01 - …"). **Segue-se o XSD**, que é o que valida, e o teste prova que `1` não passa.
9. **Simulador.** Autoriza a substituta só se a chave for de nota autorizada nele (senão `E0044`) e não cancelada nem substituída (senão `E0046`). Ao autorizar, registra sozinho o e105102 na original.

## Fora deste ADR
- **Consulta do e105102 na original:** o autorizador o gera junto com a substituta, e a NFS-e substituta já é a evidência. Baixar o evento fica para quando houver o download de XML.
- **Liberação da `externalReference`:** como na nota cancelada, a original `SUBSTITUTED` continua ocupando a referência. A substituta precisa de outra referência ou de nenhuma. A revisão é decisão do responsável, a mesma pendência do ADR-0035.
- O prazo do município (E0050) e as regras que dependem da parametrização municipal (E0056, E0058, E0074).

## Alternativas consideradas
- **Original em `SUBSTITUTING` durante o envio.** Rejeitada: a original continua valendo até a substituta ser autorizada, e um estado intermediário misturaria duas máquinas. A trava fica no índice e na exclusão mútua.
- **Escolher o estabelecimento ou o canal no corpo.** Rejeitada: a E0042 e a E0065 os fixam, e aceitar o campo só abriria espaço para erro.
- **Conferir no motor todas as regras do Anexo I.** Rejeitada: as de nível 3 dependem da parametrização do município, que não temos, e conferir sem fonte seria inventar regra.

## Consequências
- Uma repetição nunca gera duas substitutas, nem uma dúvida (`UNKNOWN`), nem uma corrida com o cancelamento.
- A original só muda com prova: a substituta `AUTHORIZED`.
- Novas transições no domínio e no trigger: `AUTHORIZED → SUBSTITUTED`; `SUBSTITUTED` é final.
