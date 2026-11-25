# ADR-0059 — Todos os erros da rejeição da NFS-e

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0027 item 7 e doc 17 B7 ("downloads de XML de rejeição");
  - ADR-0038 (formato das respostas da SEFIN);
  - ADR-0054 (`authorizerStatus`).

## Contexto
O roadmap da Fase 2a pedia o "download do XML de rejeição" (ADR-0027, inspirado na NF-e). Na NFS-e Nacional, esse XML não existe.
- A SEFIN responde à DPS rejeitada com JSON: `erros[]`, cada um com código e descrição (Swagger lido em 13/11/2026; formato real observado no ADR-0038).
- O emissor municipal de Teresina (DSF) responde no mesmo formato, com códigos `Lxxxx`.
- Não há documento de rejeição assinado para guardar ou baixar.

O que se perdia era outra coisa. Uma rejeição pode trazer vários erros, e o motor gravava só o primeiro código, mais um texto com todos juntos. Quem integra precisava interpretar esse texto para corrigir tudo de uma vez.

## Decisão
1. **Sem "XML de rejeição" na NFS-e:** o item B7 não se aplica a este documento. Ele continua valendo para a NF-e e a NFC-e (Fases 3 e 4), em que o retorno é XML.
2. **A lista completa vai para o banco e para a API.**
   - O gateway devolve `errors[]`, com `code` e `message`, na ordem do autorizador. O teto é de 50 erros, e cada mensagem é cortada no mesmo limite de antes.
   - O worker-fiscal grava a lista em `service_invoices.rejection_errors` (jsonb), junto com o primeiro código.
   - Migrations 0032 e 0033: lista não vazia, só com `rejection_code`; só o worker-fiscal grava.
3. **Na API**, `rejection.errors` traz todos os erros. `rejection.code` e `rejection.message` continuam como antes, sem quebra de contrato.
   - Rejeição gravada antes desta mudança: `errors` sai com um item só, o código e a mensagem que já existiam.
4. **Cancelamento** (acréscimo de 2026-11-25): o pedido de cancelamento rejeitado também traz `rejection.errors`.
   - A lista é gravada em `service_invoice_cancellations.rejection_errors`, só em pedido `REJECTED` com código.
   - Migrations 0034 e 0035: o worker-fiscal grava; a API e o operador leem.

## Consequências
- O cliente corrige todos os erros de uma vez, lendo `rejection.errors[].code`, sem interpretar texto.
- Nada muda na decisão do motor: o status continua `REJECTED` pelo primeiro código, como antes.
