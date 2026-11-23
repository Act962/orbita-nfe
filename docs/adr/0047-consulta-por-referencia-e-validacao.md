# ADR-0047 — Consulta pela referência externa, validação sem efeitos e referência por ambiente

- Status: **Aceito** · Data: 2026-11-23
- Relacionados:
  - ADR-0007 (idempotência);
  - ADR-0026 (itens 1 e 4);
  - ADR-0032 (aceite);
  - ADR-0037 (regras do Anexo I no aceite).

## Contexto
O ADR-0026 previu dois itens da API que ainda não existiam:

1. **Consulta pela referência externa.** Um sistema que perdeu a resposta do `POST` e também não guardou a `Idempotency-Key` não tinha como achar a nota. Sem essa consulta, a saída que sobra é emitir de novo, que é justamente o que não pode acontecer.
2. **Validação de documento sem efeitos.** Hoje, o integrador só descobre uma recusa do Anexo I, do roteamento ou da série tentando emitir.

Ao desenhar a consulta, apareceu uma inconsistência. O índice único da referência era por (empresa, aplicação, referência), sem o ambiente. Por isso, uma nota de homologação com a referência `pedido-1` bloqueava `pedido-1` em produção, e o `409` apontava para um id que a credencial de produção não consegue consultar (`404`: ambientes não se enxergam, ADR-0032).

## Decisão
1. **`GET /v1/service-invoices?externalReference=…`** (`nfse:read`).
   - Devolve `{ items: [...] }`: as notas da aplicação com a referência, **no ambiente da credencial**, da mais nova para a mais antiga, até 50.
   - Inclui as REJECTED e FAILED, porque a referência volta a ficar livre depois delas.
   - Lista vazia significa que nenhuma nota tem essa referência.
   - **Diferença do previsto:** o doc 11 previa `GET /v1/<modalidade>/by-reference/{ref}`. Ficou um filtro na coleção porque uma referência pode ter mais de uma nota (uma rejeitada e a que veio depois) e porque a referência pode ter caracteres que não cabem num segmento de caminho.
2. **`POST /v1/service-invoices/validation`** (`nfse:issue`, o mesmo escopo de quem emite).
   - **Mesmo corpo da emissão.** Faz as mesmas conferências, na mesma ordem e com os mesmos erros:
     - contrato e XSD oficial do ambiente;
     - referência ocupada, estabelecimento e canal (ADR-0028);
     - regras do Anexo I e do canal;
     - habilitação de produção e série, incluindo a THE-002.
   - **Sem efeitos:** não numera, não grava, não audita nem enfileira, e não pede `Idempotency-Key`.
   - **Resposta `200`:** `{ valid: true, environment, channel, series, ruleSetVersion, routingTableVersion }`.
   - **O código é o mesmo do aceite.** As conferências saíram para um método `check`, que o aceite chama antes de numerar e a validação chama sozinho. Assim, as duas não podem divergir.
   - **Passar não garante a autorização.** As regras de cadastro e de parametrização do município continuam com o autorizador (ADR-0037).
3. **A referência externa passa a ser por ambiente.** A migration 0022 recria `uq_service_invoices_external_reference` com o `environment`, e a conferência do aceite filtra pelo ambiente. Ela também cria `ix_service_invoices_external_reference`, que não é parcial e inclui as notas REJECTED e FAILED, para a consulta.

## Consequências
- O caminho seguro para quem perdeu a resposta fica documentado: primeiro a mesma `Idempotency-Key`; sem ela, a consulta pela referência; e emitir de novo só se a lista vier vazia ou só com REJECTED/FAILED.
- **Mudança de comportamento:** a mesma referência pode ser usada uma vez em homologação e outra em produção. Antes, isso dava `409 DOCUMENT_IN_PROGRESS`. Não há nota de produção ainda, então nenhum dado muda.
- A `Idempotency-Key` continua sem o ambiente no índice. Isso é seguro: o hash do pedido inclui o ambiente, então reusar a chave no outro ambiente dá `422 IDEMPOTENCY_KEY_REUSED` e nunca uma segunda nota.
- A validação custa o mesmo XSD do aceite (cerca de 90 ms) e passa pelo rate limit da credencial.
