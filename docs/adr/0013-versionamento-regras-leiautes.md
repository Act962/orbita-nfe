# ADR-0013 — Versionamento de regras fiscais, leiautes e schemas

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
- XSDs oficiais versionados em `resources/fiscal/schemas/<doc>/<versão>` com origem e SHA-256.
- Regras fiscais agrupadas em *rule sets* versionados com vigência (`validFrom`/`validTo`), cada regra com documento de origem em `docs/fiscal/regras/`.
- O documento grava `layoutVersion` e `ruleSetVersion` na aceitação; reprocessamentos (consulta, cancelamento, PDF) usam a versão original.
- Tabelas oficiais (municípios, códigos de serviço, cStat) como dados versionados.

## Consequências
Atualizações fiscais (NTs, Reforma Tributária) não alteram documentos históricos.
