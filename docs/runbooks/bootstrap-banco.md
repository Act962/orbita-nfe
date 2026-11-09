# Runbook — Bootstrap e migrations do PostgreSQL

Topologia de papéis (ADR-0011, docs/architecture/14 §B2):

| Papel | Tipo | Uso |
|---|---|---|
| superusuário do provedor | login | **só** este bootstrap. Nunca configurado na aplicação |
| `fiscal_owner` | login, **sem** superuser, CREATEROLE | dono das tabelas; roda migrations. O `FORCE ROW LEVEL SECURITY` vale para ele |
| `fiscal_api`, `fiscal_worker`, `fiscal_general`, `fiscal_system` | grupo (NOLOGIN), criados pela migration 0001 | privilégios e RLS |
| `app_api`, `app_worker`, `app_general` | login, membros dos grupos acima | conexões da aplicação (`DATABASE_URL` de cada container) |

Nenhum papel de aplicação tem `SUPERUSER` ou `BYPASSRLS`. O meta-teste (`test/integration/rls-meta.test.ts`) verifica isso.

## 1. Bootstrap (uma vez por banco, como superusuário)
```sql
CREATE ROLE fiscal_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '<gerada, guardada no Coolify>';
ALTER DATABASE orbita_nfe OWNER TO fiscal_owner;
ALTER SCHEMA public OWNER TO fiscal_owner;
```

## 2. Migrations (a cada deploy, antes de subir a nova versão)
Job de deploy com `MIGRATION_DATABASE_URL` apontando para `fiscal_owner`:
```bash
node dist/db/migrate.js
```
Em desenvolvimento: `npm run db:migrate`. A falha imprime só o código SQLSTATE (nunca a mensagem do driver).

## 3. Usuários de login da aplicação (uma vez, após a primeira migration, como superusuário ou fiscal_owner)
```sql
CREATE ROLE app_api     LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '<gerada>' IN ROLE fiscal_api;
CREATE ROLE app_worker  LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '<gerada>' IN ROLE fiscal_worker;
CREATE ROLE app_general LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '<gerada>' IN ROLE fiscal_general;
```

## 4. Verificação
- `GET /health/ready` → `postgres: ok`.
- Opcional: rodar a consulta de auditoria de `test/integration/support/rls-audit.ts` contra o banco.

## Ambiente local
`docker compose -f docker/docker-compose.yml up -d postgres` executa os passos 1 e 3 automaticamente (`docker/postgres-init/01-bootstrap.sql`); depois `npm run db:migrate`. Para recriar do zero: `docker compose -f docker/docker-compose.yml down -v`.
