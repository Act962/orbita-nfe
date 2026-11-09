# ADR-0025 — "Empresa" (company) no lugar de "tenant" em todo o sistema

- Status: **Aceito** · Data: 2026-11-09 · Pedido e aprovado pelo responsável em 2026-11-09

## Contexto
O sistema chamava de "tenant" o contribuinte identificado pela raiz do CNPJ, e o módulo de cadastro se chamava `taxpayer`. Para quem integra (Orbita, NERP) e para quem lê o código, "empresa" é o termo do negócio; "tenant" é jargão de arquitetura.

## Decisão
Um único vocabulário, de ponta a ponta:

| Antes | Depois |
|---|---|
| `POST /v1/tenants`, `GET /v1/tenant` | `POST /v1/companies`, `GET /v1/company` |
| `X-Tenant-Id` | `X-Company-Id` |
| escopos `tenants:*` | `companies:create`, `companies:read`, `companies:manage` |
| `TENANT_ACCESS_DENIED`, `TENANT_SUSPENDED`, `TENANT_ALREADY_REGISTERED`, `TENANT_NOT_FOUND` | `COMPANY_ACCESS_DENIED`, `COMPANY_SUSPENDED`, `COMPANY_ALREADY_REGISTERED`, `COMPANY_NOT_FOUND` |
| tabelas `tenants`, `tenant_grants`; coluna `tenant_id` | `companies`, `company_grants`; `company_id` |
| `app.tenant_id`, `app_current_tenant()`, políticas `tenant_isolation` | `app.company_id`, `app_current_company()`, `company_isolation` |
| módulo `taxpayer`, `TenantTransactions` | módulo `company`, `CompanyTransactions` |
| regra TAXPAYER-001 | [COMPANY-001](../fiscal/regras/COMPANY-001.md) |
| CLI `--tenant` | `--company` |

Código e contrato da API em inglês (`company`); documentação, mensagens de erro e Scalar em português ("empresa"). O conceito técnico continua o mesmo: isolamento multiempresa por RLS (ADR-0011).

## Migrations
Como nada foi implantado, as migrations foram **reescritas** em vez de acumular renomeações: `0000_initial_schema` (tabelas, gerada pelo Drizzle Kit) e `0001_security_roles_rls` (papéis, grants, RLS e trigger, escrita à mão). A partir do primeiro deploy, migrations aplicadas **nunca** são reescritas; mudanças entram como migrations novas.

## Consequências
- Bancos locais criados antes desta decisão precisam ser recriados (`docker compose -f docker/docker-compose.yml down -v` e `npm run db:migrate`).
- Nenhum consumidor externo afetado (API ainda não publicada).
