-- Âncora externa da auditoria (ADR-0031, docs/architecture/14 §A4). Escrito à mão e revisado.
--
-- O worker-general grava a cabeça de cada cadeia num bucket com Object Lock. Ele continua sem
-- NENHUM privilégio nas tabelas de auditoria: lê só (sequência, hash) por estas duas funções.

-- ===================================================================================
-- 1. Cabeça da empresa do CONTEXTO (app.company_id da transação). Sem empresa = erro.
CREATE FUNCTION audit_company_head_for_anchor() RETURNS TABLE (last_sequence bigint, last_hash bytea)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  company uuid := app_current_company();
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'âncora sem empresa no contexto' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT h.last_sequence, h.last_hash FROM audit_chain_heads h WHERE h.company_id = company;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_company_head_for_anchor() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_company_head_for_anchor() TO fiscal_general;
--> statement-breakpoint

-- ===================================================================================
-- 2. Cabeça da cadeia da plataforma (operador).
CREATE FUNCTION audit_platform_head_for_anchor() RETURNS TABLE (last_sequence bigint, last_hash bytea)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT h.last_sequence, h.last_hash FROM platform_audit_head h WHERE h.id = 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_platform_head_for_anchor() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_platform_head_for_anchor() TO fiscal_general;
