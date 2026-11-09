# ADR-0011 — Multiempresa em schema compartilhado com RLS

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
`company_id` em todas as tabelas de empresa; RLS com `current_setting('app.company_id')` definido por `SET LOCAL` em cada transação; papel da aplicação sem `BYPASSRLS`; papel de sistema separado e auditado para jobs globais. Empresa resolvida no servidor a partir da credencial + concessão; o CNPJ do payload é apenas conferido.

## Condição da aprovação
Aprovado **com testes rigorosos de isolamento** como gate bloqueante do CI: meta-teste de schema (RLS `ENABLE` + `FORCE` + políticas `USING`/`WITH CHECK` em toda tabela com `company_id`), matriz de API gerada a partir das rotas, testes cruzados por repository, vazamento de pool, jobs, storage, testes baseados em propriedades e "teste do teste". Contexto definido por `set_config('app.company_id', $1, true)` (escopo de transação) e política *fail-closed*. Detalhes: [14-integridade-isolamento.md](../architecture/14-integridade-isolamento.md).

## Alternativas
Schema por empresa / banco por empresa: isolamento maior, operação e migrations muito mais caras. Reavaliar se surgir exigência contratual.
