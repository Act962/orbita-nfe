# ADR-0015 — Webhooks assinados com retentativas e deduplicação

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Eventos via outbox; entrega com `Webhook-Id`, `Webhook-Timestamp` e `Webhook-Signature` (HMAC-SHA256 de `id.timestamp.body`, segredo por assinatura), retries exponenciais por até ~24h, DLQ e reenvio manual. Payload mínimo (ids/status), sem XML. Proteção contra SSRF no cadastro e na entrega.
