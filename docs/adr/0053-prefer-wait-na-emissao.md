# ADR-0053 — `Prefer: wait` na emissão e na substituição da NFS-e

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0026 item 2 e doc 16 A3 (201 × 202 com `Prefer: wait`);
  - ADR-0022 e ADR-0032 (write-ahead e emissão assíncrona pelo worker-fiscal);
  - ADR-0036 (substituição).

## Contexto
A emissão é assíncrona: a API aceita, reserva o número e responde 202; o worker-fiscal transmite. Quem consome (Orbita, NERP) precisa consultar ou assinar o webhook para saber o resultado. Para um sistema que emite uma nota e mostra o resultado na tela, isso obriga a montar um laço de consulta. O ADR-0026 adotou o `Prefer: wait` da RFC 7240 para esse caso: 201 se o resultado saiu dentro da espera, 202 se não.

## Decisão
1. **`Prefer: wait=<segundos>`** em `POST /v1/service-invoices` e em `POST /v1/service-invoices/{id}/substitution`.
   - Limitado a **20 segundos**, abaixo do tempo limite comum de proxies (60 s). Pedido maior é reduzido ao máximo.
   - Valor ausente, zero ou malformado: a preferência é ignorada, como manda a RFC 7240 §2.
   - Com a espera aplicada, a resposta traz `Preference-Applied: wait=<segundos usados>`.
2. **A espera não muda o processamento.** A nota é aceita e gravada exatamente como antes (mesma transação, mesmo job). A API só consulta a nota no banco, com intervalo crescente (200 ms até 1 s), sem transação aberta durante a espera, até:
   - a nota sair de `PENDING`/`PROCESSING`;
   - o prazo acabar;
   - o cliente desconectar.
3. **Códigos de resposta.**
   - **201:** nota nova que terminou dentro da espera (`AUTHORIZED`, `REJECTED` ou `FAILED`).
   - **202:** nota nova ainda em andamento, ou em `UNKNOWN`. Em `UNKNOWN` a espera acaba na hora: a reconciliação leva mais que a espera, e o cliente **não** deve reemitir.
   - **200:** repetição idempotente, com ou sem espera (a resposta traz o estado depois de esperar).
4. **Falha na consulta durante a espera não vira erro da emissão.** A nota já foi aceita: a API responde 202 com o último estado lido. Um 500 levaria o cliente a crer que nada foi aceito.
5. **Sem atalho de rede.** A API continua sem falar com o autorizador nem com o worker; o worker não é acordado de forma especial. Quanto o resultado demora depende do intervalo de consulta da fila (`WORKER_POLL_INTERVAL_MS`) e do autorizador.

## Consequências
- Cada requisição com espera ocupa uma conexão HTTP e faz algumas consultas curtas ao banco. Com o limite de 20 s e o intervalo crescente, são no máximo cerca de 25 consultas por requisição.
- Timeout continua sem provar nada: 202 depois da espera **não** quer dizer que a nota não foi emitida (regra do doc 12). O guia diz para consultar depois ou esperar o webhook.
- **Ainda fora:** a NFC-e (Fase 3), onde o PDV deve ter espera curta por padrão.

## Acréscimo (2026-11-24): pedido de cancelamento
A mesma preferência vale em `POST /v1/service-invoices/{id}/cancellation`, com as mesmas regras:
- **201:** pedido novo que terminou dentro da espera (`REGISTERED`, `REJECTED` ou `FAILED`);
- **202:** ainda em andamento ou em `UNKNOWN` (a espera acaba na hora; **não** peça de novo);
- **200:** repetição do mesmo corpo.

A espera é a mesma rotina, com a regra de "em andamento" e de "final" de cada recurso.
