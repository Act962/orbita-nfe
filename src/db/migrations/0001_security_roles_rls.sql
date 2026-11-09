-- Segurança do banco: papéis, grants e Row-Level Security (ADR-0011, docs/architecture/14 Parte B).
-- Escrito à mão e revisado. Toda tabela nova com company_id precisa de bloco equivalente:
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

-- 2. Empresa corrente da transação. NULL quando não definida → políticas não liberam nada (fail-closed).
CREATE OR REPLACE FUNCTION app_current_company() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_company() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_company() TO fiscal_api, fiscal_worker, fiscal_general, fiscal_system;
--> statement-breakpoint

-- 3. Privilégios mínimos.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fiscal_api, fiscal_worker, fiscal_general, fiscal_system;
--> statement-breakpoint
REVOKE ALL ON companies, establishments FROM PUBLIC;
--> statement-breakpoint
-- Sem DELETE: dados fiscais não são apagados pela aplicação.
GRANT SELECT, INSERT, UPDATE ON companies, establishments TO fiscal_api, fiscal_worker;
--> statement-breakpoint

-- 4. RLS habilitado E forçado (FORCE aplica a política também ao dono da tabela).
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON companies
  USING (id = app_current_company())
  WITH CHECK (id = app_current_company());
--> statement-breakpoint
ALTER TABLE establishments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE establishments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON establishments
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());

--> statement-breakpoint

-- ===================================================================================
-- Segurança de IAM e Fiscal Settings (ADR-0011, ADR-0012, ADR-0008). Escrito à mão e revisado.

-- 1. Papel do operador (CLI de administração de aplicações, credenciais e concessões).
--    Sem BYPASSRLS: concessões são gravadas no contexto da empresa, como qualquer dado de empresa.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fiscal_admin') THEN
    CREATE ROLE fiscal_admin NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fiscal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_company() TO fiscal_admin;
--> statement-breakpoint

-- 2. FKs entre módulos (os schemas Drizzle de um módulo não importam os de outro).
ALTER TABLE company_grants
  ADD CONSTRAINT fk_company_grants_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint
-- Composta: a série só referencia estabelecimento do MESMA empresa.
ALTER TABLE document_series
  ADD CONSTRAINT fk_document_series_establishment FOREIGN KEY (company_id, establishment_id)
  REFERENCES establishments (company_id, id);
--> statement-breakpoint

-- 3. Numeração nunca volta e a identidade da série não muda (ADR-0008: número que pode ter
--    chegado ao autorizador não é reutilizado). Vale para todos os papéis, inclusive o dono.
CREATE FUNCTION document_series_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.next_number < OLD.next_number THEN
    RAISE EXCEPTION 'document_series.next_number não pode diminuir'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_document_series_monotonic';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.series IS DISTINCT FROM OLD.series
     OR NEW.max_number IS DISTINCT FROM OLD.max_number THEN
    RAISE EXCEPTION 'identidade da série é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_document_series_immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION document_series_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_document_series_guard BEFORE UPDATE ON document_series
  FOR EACH ROW EXECUTE FUNCTION document_series_guard();
--> statement-breakpoint

-- 4. Privilégios mínimos. Nenhum DELETE para a aplicação.
REVOKE ALL ON client_applications, credentials, company_grants, document_series FROM PUBLIC;
--> statement-breakpoint
-- API: só LÊ aplicações e credenciais (autenticação). Escrita é do operador.
GRANT SELECT ON client_applications, credentials TO fiscal_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status) ON client_applications TO fiscal_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, revoked_at) ON credentials TO fiscal_admin;
--> statement-breakpoint
-- Concessões: a API cria a do próprio criador junto com a empresa; o operador concede e revoga.
GRANT SELECT, INSERT, UPDATE (status, updated_at) ON company_grants TO fiscal_api, fiscal_admin;
--> statement-breakpoint
GRANT SELECT ON companies TO fiscal_admin;
--> statement-breakpoint
-- Séries: só número, status e data podem mudar (o trigger impede o número de voltar).
GRANT SELECT, INSERT, UPDATE (next_number, status, updated_at) ON document_series TO fiscal_api;
--> statement-breakpoint
GRANT SELECT ON document_series TO fiscal_worker;
--> statement-breakpoint

-- 5. RLS habilitado e forçado nas tabelas de empresa.
ALTER TABLE company_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON company_grants
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE document_series ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_series FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON document_series
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
