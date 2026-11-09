-- Segurança do banco: papéis, grants e Row-Level Security (ADR-0011, docs/architecture/14 Parte B).
-- Escrito à mão e revisado. Toda tabela nova com tenant_id precisa de bloco equivalente:
-- o meta-teste de schema (test/integration/rls-meta.test.ts) quebra o build se faltar.

-- 1. Papéis de grupo (NOLOGIN). Usuários de login são criados no deploy e recebem estes papéis.
--    Nenhum deles tem BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscal_api') THEN
    CREATE ROLE fiscal_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscal_worker') THEN
    CREATE ROLE fiscal_worker NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscal_general') THEN
    CREATE ROLE fiscal_general NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscal_system') THEN
    CREATE ROLE fiscal_system NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- 2. Tenant corrente da transação. NULL quando não definido → políticas não liberam nada (fail-closed).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_tenant() TO fiscal_api, fiscal_worker, fiscal_general, fiscal_system;
--> statement-breakpoint

-- 3. Privilégios mínimos.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fiscal_api, fiscal_worker, fiscal_general, fiscal_system;
--> statement-breakpoint
REVOKE ALL ON tenants, establishments FROM PUBLIC;
--> statement-breakpoint
-- Sem DELETE: dados fiscais não são apagados pela aplicação.
GRANT SELECT, INSERT, UPDATE ON tenants, establishments TO fiscal_api, fiscal_worker;
--> statement-breakpoint

-- 4. RLS habilitado E forçado (FORCE aplica a política também ao dono da tabela).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE establishments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE establishments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON establishments
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
