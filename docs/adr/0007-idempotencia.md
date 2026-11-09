# ADR-0007 — Idempotência em duas camadas

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
1. `Idempotency-Key` obrigatório nos POSTs fiscais, único por (empresa, aplicação cliente, chave), guardando hash do corpo normalizado. Mesmo hash → mesma resposta; hash diferente → 422 `IDEMPOTENCY_KEY_REUSED`. Retenção mínima de 30 dias (configurável).
2. Chaves naturais fiscais com `UNIQUE` no banco: (estabelecimento, ambiente, série, número), chave de acesso, identificador da DPS.
3. Jobs idempotentes por recarga de estado + lock otimista.

## Consequências
Repetição de requisição ou de job nunca gera um segundo documento.
