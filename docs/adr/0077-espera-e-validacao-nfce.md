# ADR-0077 — `Prefer: wait` e validação sem emitir na NFC-e

- Status: **Aceito** · Data: 2026-11-27
- Relacionados:
  - ADR-0053 (`Prefer: wait` na NFS-e, o molde);
  - ADR-0047 (validação sem efeitos na NFS-e);
  - ADR-0072 (núcleo da NFC-e).

## Contexto
A NFS-e já tinha duas facilidades que a NFC-e não tinha:
- a espera pelo resultado na emissão;
- a validação sem efeitos.

Na NFC-e elas pesam mais: o caixa precisa do resultado da venda na hora, e o PDV quer conferir a venda antes de fechá-la. Nenhuma das duas depende do autorizador real.

## Decisão
1. **`Prefer: wait=<segundos>` em `POST /v1/consumer-invoices`** (RFC 7240, máximo de 20 s, o mesmo da NFS-e):
   - a resposta espera, consultando o banco, até a nota sair de `PENDING`/`PROCESSING`;
   - **201** se ela terminou dentro do prazo (`AUTHORIZED`, `REJECTED`, `DENIED` ou `FAILED`);
   - **202** se não terminou, inclusive em `UNKNOWN`: a consulta pela chave leva mais tempo que a espera;
   - **200** na repetição idempotente;
   - `Preference-Applied` quando a espera foi aplicada.

   O processamento continua no worker-fiscal, e nenhuma transação fica aberta durante a espera.
   O mecanismo foi para `shared/presentation/http/prefer-wait.ts`; a NFS-e reexporta e mantém as políticas dela.
2. **`POST /v1/consumer-invoices/validation`** (`nfce:issue`, o escopo de quem emite):
   - o mesmo corpo da emissão e as mesmas conferências, na mesma ordem e com os mesmos erros. O aceite e a validação usam o mesmo método `check`, para não divergirem;
   - sem `Idempotency-Key`, sem numerar, gravar, auditar nem enfileirar;
   - responde 200 com o ambiente e a série que seriam usados;
   - a rota está na matriz de isolamento.

## Consequências
- O PDV pode emitir e já receber o resultado numa chamada, sem consultar depois, na maior parte dos casos.
- Passar na validação não garante a autorização: o cadastro do contribuinte e as regras que dependem da base da SEFAZ continuam sendo do autorizador.
