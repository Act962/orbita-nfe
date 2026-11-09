# ADR-0016 — Observabilidade: pino, OpenTelemetry, Prometheus

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Logs JSON (pino) com redaction e correlation id; tracing OTel (HTTP, DB, chamadas a autorizadores, jobs); métricas Prometheus: documentos por status/modalidade, idade do `UNKNOWN` mais antigo, latência por autorizador, taxa de rejeição por código, profundidade de fila, DLQ, certificados a vencer, estado dos circuit breakers. `/health/live` e `/health/ready` (DB, S3, KMS).
