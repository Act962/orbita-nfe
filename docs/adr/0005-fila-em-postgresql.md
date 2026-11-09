# ADR-0005 — Fila persistente em PostgreSQL (outbox implícito)

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Contexto
A mudança de estado do documento e o agendamento do próximo passo precisam ser atômicos. Uma fila externa ao banco cria *dual write*.

## Decisão
Jobs no PostgreSQL: pg-boss, se o spike confirmar que o enqueue participa da transação da aplicação; caso contrário, tabela própria com `FOR UPDATE SKIP LOCKED`. Retentativas com backoff exponencial + jitter, DLQ, agendamento cron. Handlers idempotentes. Porta `JobQueue` na camada de aplicação.

## Resultado do spike 04 (2026-11-09)
**pg-boss 12 confirmado**: `send(..., { db })` com o client da transação da aplicação respeita COMMIT/ROLLBACK. Política `exclusive` + `singletonKey = documentId` garante no máximo um job por documento (fila ou ativo); SKIP LOCKED sem entrega duplicada com 8 workers; DLQ funcionando. A implementação própria com SKIP LOCKED não será necessária. Detalhes: [resultados dos spikes](../spikes/resultados-fase1.md).

## Alternativas
- BullMQ/Redis: ótimo throughput, mas não transacional com o estado fiscal e durabilidade dependente de AOF.
- RabbitMQ/SQS + relay de outbox: mais componentes sem necessidade atual.

## Consequências
Um sistema a menos para operar. Redis restrito a rate limit/cache. Reavaliar sob teste de carga (Fase 5).
