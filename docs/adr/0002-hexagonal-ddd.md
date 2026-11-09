# ADR-0002 — Hexagonal + DDD por contexto, DI explícita

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Cada contexto tem `domain`, `application` (casos de uso + portas), `infrastructure` (adapters) e `presentation` (HTTP, job handlers). Domínio em TypeScript puro, sem dependências de framework. Composição manual em `src/main/container.ts` (fábricas), sem container de DI baseado em decorators/reflection.

## Alternativas
- NestJS / tsyringe: produtivos, mas incentivam acoplamento a decorators e escondem o grafo de dependências.

## Consequências
Grafo explícito e testável; um pouco mais de código de wiring.
