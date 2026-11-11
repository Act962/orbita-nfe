-- Segurança da habilitação de produção (ADR-0027 item 1, ADR-0011). Escrito à mão e revisado.

-- ===================================================================================
-- 1. Integridade referencial: a habilitação só aponta para estabelecimento da MESMA empresa.
ALTER TABLE production_enablements
  ADD CONSTRAINT fk_production_enablements_establishment FOREIGN KEY (company_id, establishment_id)
  REFERENCES establishments (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Ciclo de vida: só ACTIVE → REVOKED. Identidade, modalidade e data de habilitação são
--    imutáveis; revogada é final. Nenhum papel apaga (o histórico é a prova de quem habilitou).
CREATE FUNCTION production_enablements_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'habilitação de produção não pode ser apagada'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_production_enablements_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.enabled_at IS DISTINCT FROM OLD.enabled_at THEN
    RAISE EXCEPTION 'identidade da habilitação de produção é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_production_enablements_immutable';
  END IF;
  IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED') THEN
    RAISE EXCEPTION 'transição de habilitação inválida: % → %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_production_enablements_transition';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION production_enablements_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_production_enablements_guard BEFORE UPDATE OR DELETE ON production_enablements
  FOR EACH ROW EXECUTE FUNCTION production_enablements_guard();
--> statement-breakpoint
CREATE TRIGGER trg_production_enablements_no_truncate BEFORE TRUNCATE ON production_enablements
  FOR EACH STATEMENT EXECUTE FUNCTION production_enablements_guard();
--> statement-breakpoint

-- ===================================================================================
-- 3. Privilégios mínimos. A API habilita e revoga (só status e dados da revogação mudam);
--    o worker-fiscal só consulta (trava L5 do pré-envio, Fase 2a). Nenhum DELETE.
REVOKE ALL ON production_enablements FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT (id, company_id, establishment_id, kind) ON production_enablements TO fiscal_api;
--> statement-breakpoint
GRANT UPDATE (status, revoked_at, revocation_reason) ON production_enablements TO fiscal_api;
--> statement-breakpoint
GRANT SELECT ON production_enablements TO fiscal_worker;
--> statement-breakpoint

-- ===================================================================================
-- 4. RLS habilitado e forçado.
ALTER TABLE production_enablements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE production_enablements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON production_enablements
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
