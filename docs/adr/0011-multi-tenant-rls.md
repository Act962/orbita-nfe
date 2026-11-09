# ADR-0011 — Multi-tenant em schema compartilhado com RLS

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
`tenant_id` em todas as tabelas de tenant; RLS com `current_setting('app.tenant_id')` definido por `SET LOCAL` em cada transação; papel da aplicação sem `BYPASSRLS`; papel de sistema separado e auditado para jobs globais. Tenant resolvido no servidor a partir da credencial + concessão; o CNPJ do payload é apenas conferido.

## Condição da aprovação
Aprovado **com testes rigorosos de isolamento** como gate bloqueante do CI: meta-teste de schema (RLS `ENABLE` + `FORCE` + políticas `USING`/`WITH CHECK` em toda tabela com `tenant_id`), matriz de API gerada a partir das rotas, testes cruzados por repository, vazamento de pool, jobs, storage, testes baseados em propriedades e "teste do teste". Contexto definido por `set_config('app.tenant_id', $1, true)` (escopo de transação) e política *fail-closed*. Detalhes: [14-integridade-isolamento.md](../architecture/14-integridade-isolamento.md).

## Alternativas
Schema por tenant / banco por tenant: isolamento maior, operação e migrations muito mais caras. Reavaliar se surgir exigência contratual.
