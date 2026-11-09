# ADR-0008 — Reserva de numeração transacional

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Número alocado na transação de aceitação via `UPDATE document_series SET next_number = next_number + 1 ... RETURNING`. Rollback não consome número. Lacunas posteriores são tratadas conforme a modalidade (NF-e/NFC-e: inutilização; NFS-e: conforme manual nacional — pendente de confirmação). Nunca reutilizar número de documento que possa ter chegado ao autorizador.

## Consequências
Sem duplicatas sob concorrência; contenção por série aceitável no volume esperado (medir na Fase 5).
