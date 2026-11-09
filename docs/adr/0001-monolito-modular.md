# ADR-0001 — Monólito modular com processos api e worker

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Contexto
Equipe pequena, domínio fiscal ainda sendo descoberto, necessidade de transações atômicas entre documento, numeração, fila e auditoria.

## Decisão
Um repositório e um deployable, com bounded contexts como módulos isolados (`src/modules/*`, superfície pública em `public.ts`, regras verificadas por dependency-cruiser no CI). Dois papéis de processo — `api` e `worker` — escaláveis separadamente. O worker roda em dois containers com privilégios distintos (`worker-fiscal` e `worker-general`, ver ADR-0021). Mesma imagem, comandos diferentes.

## Alternativas
- Microsserviços por documento: custo operacional alto, transações distribuídas, sem benefício na escala atual.
- Monorepo multi-pacote desde o início: overhead de build; adiado até haver consumidor externo de um pacote (ex.: agente NFC-e offline, ADR-0019).

## Consequências
+ Transações locais, deploy simples, refatoração barata.
− Exige disciplina de fronteiras (automatizada no CI).
