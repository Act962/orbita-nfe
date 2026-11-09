# ADR-0005 — Fila persistente em PostgreSQL (outbox implícito)

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Contexto
A mudança de estado do documento e o agendamento do próximo passo precisam ser atômicos. Uma fila externa ao banco cria *dual write*.

## Decisão
Jobs no PostgreSQL: pg-boss, se o spike confirmar que o enqueue participa da transação da aplicação; caso contrário, tabela própria com `FOR UPDATE SKIP LOCKED`. Retentativas com backoff exponencial + jitter, DLQ, agendamento cron. Handlers idempotentes. Porta `JobQueue` na camada de aplicação.

## Alternativas
- BullMQ/Redis: ótimo throughput, mas não transacional com o estado fiscal e durabilidade dependente de AOF.
- RabbitMQ/SQS + relay de outbox: mais componentes sem necessidade atual.

## Consequências
Um sistema a menos para operar. Redis restrito a rate limit/cache. Reavaliar sob teste de carga (Fase 5).
