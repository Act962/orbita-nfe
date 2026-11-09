# ADR-0003 — Stack: TypeScript, Node LTS, Fastify, Zod, Vitest

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
TypeScript strict (ESM), Node.js na versão LTS ativa na data da Fase 1, Fastify com type provider Zod e geração OpenAPI, Vitest. Zod restrito à borda (HTTP, config, parsing de dados externos); o domínio valida em Value Objects. Valores decimais com biblioteca de precisão arbitrária encapsulada em VO — nunca `number`.

## Consequências
Contratos HTTP e documentação derivados da mesma fonte. Versões exatas fixadas no lockfile na Fase 1.
