# ADR-0004 — PostgreSQL + Drizzle isolado na infraestrutura

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
PostgreSQL 16+. Drizzle ORM e Drizzle Kit apenas em `infrastructure/persistence`; mappers explícitos linha ↔ agregado; migrations geradas **e revisadas**, com SQL manual para RLS, triggers, grants e índices parciais. SQL explícito quando trouxer controle (alocação de número, `SKIP LOCKED`).

## Consequências
Domínio independente do ORM; repositories testados com PostgreSQL real (Testcontainers).
