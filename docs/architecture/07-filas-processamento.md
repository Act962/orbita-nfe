# 07 — Estratégia de filas e processamento

## 1. Decisão
Fila **persistente em PostgreSQL** (ver [ADR-0005](../adr/0005-fila-em-postgresql.md)).
Candidato principal: **pg-boss** (suporta enfileirar usando a conexão/transação da
aplicação, retries, backoff, DLQ, agendamento). Validar em *spike* da Fase 1 que o
enqueue participa da transação Drizzle; se não atender, implementar tabela `jobs`
própria com `SELECT ... FOR UPDATE SKIP LOCKED` (≈ 300 linhas, sob nosso controle).

Por que não BullMQ/Redis: o enqueue não seria atômico com a mudança de estado do
documento (dual write), e a durabilidade do Redis depende de configuração de AOF. Para
documentos fiscais, a fonte da verdade e a fila precisam estar no mesmo commit.

## 2. Filas
| Fila | Job | Concorrência | Observações |
|---|---|---|---|
| `nfse.submit` | transmitir documento | por autorizador/tenant | singleton por documento |
| `nfse.reconcile` | consultar `UNKNOWN` | baixa, rate-limited | backoff 30s → 1m → 5m → 15m → 1h… |
| `nfse.event` | cancelamento/substituição | | singleton por documento |
| `nfe.*`, `nfce.*` | análogos | | |
| `webhook.deliver` | entrega HTTP | alta | retries até 24h |
| `certificates.expiry-scan` | diário (cron) | 1 | |
| `maintenance.stuck-scan` | a cada 5 min | 1 | leases expirados |

## 3. Garantias
- **At-least-once** na fila + **handlers idempotentes** = efeito exatamente-uma-vez no domínio.
- Todo handler começa recarregando o agregado e checando o estado: job de `submit` para documento já `AUTHORIZED` é no-op.
- **Lease/lock por documento**: transição `PENDING → PROCESSING` usa `UPDATE ... WHERE status='PENDING' AND version=$v` (lock otimista) e grava `lease_until`. Um segundo worker não consegue pegar o mesmo documento.
- Worker que morre: o lease expira e o *stuck-scan* move o documento para `UNKNOWN` (se havia attempt com envio iniciado) ou `PENDING` (se não havia). **Nunca** de volta a `PENDING` se o envio pode ter começado.
- Retentativas com backoff exponencial + jitter; limite por tipo de erro; esgotou → DLQ com alerta. DLQ de documentos não "perde" nada: o documento continua com estado fiel no banco.

## 4. Transactional Outbox
Mudança de estado + `outbox_events` + `audit_log` + próximo job: **um commit**. O
dispatcher de outbox lê eventos não publicados, cria entregas de webhook e marca
publicados. Como fila e outbox estão no mesmo banco, o "relay" é só mais um job.

## 5. Correlation
`correlation_id` (header `X-Correlation-Id` ou gerado) acompanha requisição → documento → jobs → chamadas externas → webhooks → logs → spans OTel.

## 6. Separação por privilégio (ADR-0021)
Filas fiscais são consumidas **somente** pelo `worker-fiscal`; webhooks, outbox, alertas e varreduras pelo `worker-general`.

## 7. Prioridade e justiça entre tenants
- Prioridades: `nfce.submit` (consumidor no caixa) > `nfse.submit`/`nfe.submit` > eventos > `*.reconcile` > manutenção.
- Cota de concorrência por tenant e por autorizador (bulkhead): um tenant com milhares de notas não atrasa os demais.
- Lote em massa de um tenant entra com prioridade menor que emissões unitárias.

## 8. Operação manual (escopo `ops:*`, tudo auditado)
| Ação | Endpoint administrativo |
|---|---|
| Pausar/retomar fila (global, por autorizador ou por tenant) | `POST /ops/v1/queues/{queue}/pause` / `resume` |
| Listar e inspecionar DLQ | `GET /ops/v1/dead-letters` |
| Reprocessar item da DLQ | `POST /ops/v1/dead-letters/{id}/retry` |
| Descartar job (nunca o documento) | `POST /ops/v1/jobs/{id}/discard` com justificativa |
| Painel de pendências (`UNKNOWN`, `PROCESSING` antigos) | `GET /ops/v1/pending-documents` |
| Resolver `UNKNOWN` manualmente | `POST /ops/v1/documents/{id}/resolve-unknown` (doc 12 §7) |

Pausar uma fila **não** muda estado de documentos: eles permanecem `PENDING`/`UNKNOWN` fiéis.

## 9. Monitoramento da fila
Métricas: profundidade por fila, idade do job mais antigo, vazão, taxa de erro por tipo, tamanho da DLQ, tempo em `PENDING`, estado dos circuit breakers. Alertas: DLQ > 0 em filas fiscais, job mais antigo acima do limite, worker sem *heartbeat*.

## 10. Runbooks (a escrever na Fase 1, em `docs/runbooks/`)
Autorizador fora do ar · DLQ crescendo · documentos presos em `UNKNOWN` · worker travado/sem heartbeat · certificado vencido em massa · restauração de backup.

## 11. Teste de carga
Antes do go-live de cada modalidade: metas de vazão (docs/min) e latência p95 aceitação→autorização contra simulador, incluindo cenários de falha.

## 12. Escalabilidade
Primeiro gargalo esperado não é o banco e sim os autorizadores (latência e limites).
PostgreSQL com SKIP LOCKED sustenta com folga milhares de jobs/minuto. Se um dia a
escala exigir, a porta `JobQueue` permite trocar a implementação sem tocar o domínio.
