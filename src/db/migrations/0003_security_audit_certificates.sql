-- Segurança da trilha de auditoria e do cofre de certificados (docs/architecture/13 e 14 §A4;
-- ADR-0009, ADR-0011, ADR-0021). Escrito à mão e revisado.

-- ===================================================================================
-- 1. FKs entre módulos (os schemas Drizzle de um módulo não importam os de outro).
ALTER TABLE audit_log
  ADD CONSTRAINT fk_audit_log_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint
ALTER TABLE audit_chain_heads
  ADD CONSTRAINT fk_audit_chain_heads_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint
-- Composta: o certificado só referencia estabelecimento da MESMA empresa.
ALTER TABLE certificates
  ADD CONSTRAINT fk_certificates_establishment FOREIGN KEY (company_id, establishment_id)
  REFERENCES establishments (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Auditoria append-only: nenhum papel altera ou apaga registro, nem o dono das tabelas.
CREATE FUNCTION audit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  RAISE EXCEPTION 'trilha de auditoria é append-only (% em %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_audit_append_only';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_platform_audit_log_append_only BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_platform_audit_log_no_truncate BEFORE TRUNCATE ON platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
--> statement-breakpoint

-- ===================================================================================
-- 3. Cabeça da cadeia. A aplicação não tem NENHUM privilégio nas tabelas de cabeça: lê e
--    trava pela função abaixo e o trigger de inserção avança a cabeça. Assim, um registro só
--    entra se continuar exatamente a cadeia (sequência seguinte e hash anterior corretos).
CREATE FUNCTION audit_lock_head() RETURNS TABLE (last_sequence bigint, last_hash bytea)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  company uuid := app_current_company();
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'auditoria sem empresa no contexto' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit_chain_heads (company_id, last_sequence, last_hash)
    VALUES (company, 0, decode(repeat('00', 32), 'hex'))
    ON CONFLICT (company_id) DO NOTHING;
  RETURN QUERY
    SELECT h.last_sequence, h.last_hash FROM audit_chain_heads h WHERE h.company_id = company FOR UPDATE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_lock_head() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION audit_log_link() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  head record;
BEGIN
  SELECT h.last_sequence, h.last_hash INTO head FROM audit_chain_heads h WHERE h.company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> head.last_sequence + 1 OR NEW.prev_hash <> head.last_hash THEN
    RAISE EXCEPTION 'registro de auditoria não continua a cadeia da empresa'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_audit_log_chain';
  END IF;
  UPDATE audit_chain_heads SET last_sequence = NEW.sequence, last_hash = NEW.hash, updated_at = now()
    WHERE company_id = NEW.company_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_log_link() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_link BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_link();
--> statement-breakpoint

CREATE FUNCTION platform_audit_lock_head() RETURNS TABLE (last_sequence bigint, last_hash bytea)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO platform_audit_head (id, last_sequence, last_hash)
    VALUES (1, 0, decode(repeat('00', 32), 'hex'))
    ON CONFLICT (id) DO NOTHING;
  RETURN QUERY
    SELECT h.last_sequence, h.last_hash FROM platform_audit_head h WHERE h.id = 1 FOR UPDATE;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_audit_lock_head() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION platform_audit_log_link() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  head record;
BEGIN
  SELECT h.last_sequence, h.last_hash INTO head FROM platform_audit_head h WHERE h.id = 1 FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> head.last_sequence + 1 OR NEW.prev_hash <> head.last_hash THEN
    RAISE EXCEPTION 'registro de auditoria não continua a cadeia da plataforma'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_platform_audit_log_chain';
  END IF;
  UPDATE platform_audit_head SET last_sequence = NEW.sequence, last_hash = NEW.hash, updated_at = now() WHERE id = 1;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_audit_log_link() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_platform_audit_log_link BEFORE INSERT ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_audit_log_link();
--> statement-breakpoint

-- ===================================================================================
-- 4. Certificados: transições de status e imutabilidade do envelope (vale para todos os papéis).
CREATE FUNCTION certificates_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'certificado revogado não muda'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PENDING_VALIDATION' AND NEW.status IN ('ACTIVE', 'REJECTED', 'REVOKED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('REPLACED', 'REVOKED'))
    OR (OLD.status IN ('REPLACED', 'REJECTED') AND NEW.status = 'REVOKED')) THEN
    RAISE EXCEPTION 'transição de status de certificado não permitida'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_transition';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     OR NEW.envelope_version IS DISTINCT FROM OLD.envelope_version
     OR NEW.pfx_sealed IS DISTINCT FROM OLD.pfx_sealed
     OR NEW.password_sealed IS DISTINCT FROM OLD.password_sealed
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade e conteúdo cifrado do certificado são imutáveis'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_immutable';
  END IF;
  -- A chave do envelope só pode ser destruída (com REVOKED) ou re-embrulhada por outra KEK (rotação).
  IF NEW.wrapped_dek IS DISTINCT FROM OLD.wrapped_dek THEN
    IF NEW.wrapped_dek IS NULL AND NEW.status <> 'REVOKED' THEN
      RAISE EXCEPTION 'chave do envelope só é destruída na revogação'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_immutable';
    END IF;
    IF NEW.wrapped_dek IS NOT NULL AND NEW.kek_id IS NOT DISTINCT FROM OLD.kek_id THEN
      RAISE EXCEPTION 're-embrulho exige nova KEK'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_immutable';
    END IF;
  ELSIF NEW.kek_id IS DISTINCT FROM OLD.kek_id THEN
    RAISE EXCEPTION 'kek_id só muda junto com o re-embrulho'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_immutable';
  END IF;
  -- Metadados só são definidos na validação.
  IF OLD.status <> 'PENDING_VALIDATION' AND (
       NEW.subject_cnpj IS DISTINCT FROM OLD.subject_cnpj
    OR NEW.subject_name IS DISTINCT FROM OLD.subject_name
    OR NEW.issuer_name IS DISTINCT FROM OLD.issuer_name
    OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
    OR NEW.not_before IS DISTINCT FROM OLD.not_before
    OR NEW.not_after IS DISTINCT FROM OLD.not_after
    OR NEW.thumbprint_sha256 IS DISTINCT FROM OLD.thumbprint_sha256) THEN
    RAISE EXCEPTION 'metadados do certificado são imutáveis após a validação'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_certificates_immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION certificates_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_certificates_guard BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION certificates_guard();
--> statement-breakpoint

-- ===================================================================================
-- 5. Privilégios mínimos. Nenhum DELETE.
REVOKE ALL ON audit_log, audit_chain_heads, platform_audit_log, platform_audit_head, certificates FROM PUBLIC;
--> statement-breakpoint
-- Auditoria: a aplicação só INSERE; ler é do operador (verificação da cadeia).
GRANT INSERT ON audit_log TO fiscal_api, fiscal_worker, fiscal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_lock_head() TO fiscal_api, fiscal_worker, fiscal_admin;
--> statement-breakpoint
GRANT SELECT ON audit_log, audit_chain_heads TO fiscal_admin;
--> statement-breakpoint
GRANT INSERT, SELECT ON platform_audit_log TO fiscal_admin;
--> statement-breakpoint
GRANT SELECT ON platform_audit_head TO fiscal_admin;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_audit_lock_head() TO fiscal_admin;
--> statement-breakpoint
-- Certificados (docs/architecture/13 §2): a API grava o envelope e lê SÓ metadados.
GRANT INSERT (id, company_id, establishment_id, envelope_version, kek_id, wrapped_dek, pfx_sealed, password_sealed)
  ON certificates TO fiscal_api;
--> statement-breakpoint
GRANT SELECT (id, company_id, establishment_id, status, rejection_reason, subject_cnpj, subject_name, issuer_name,
              serial_number, not_before, not_after, thumbprint_sha256, created_at, validated_at, revoked_at)
  ON certificates TO fiscal_api;
--> statement-breakpoint
-- Revogação: status e destruição da chave do envelope (sem poder lê-la).
GRANT UPDATE (status, wrapped_dek, revoked_at, updated_at) ON certificates TO fiscal_api;
--> statement-breakpoint
-- worker-fiscal: lê tudo (abre o envelope com a KEK privada) e grava o resultado da validação.
GRANT SELECT ON certificates TO fiscal_worker;
--> statement-breakpoint
GRANT UPDATE (status, rejection_reason, subject_cnpj, subject_name, issuer_name, serial_number, not_before, not_after,
              thumbprint_sha256, validated_at, replaced_at, updated_at)
  ON certificates TO fiscal_worker;
--> statement-breakpoint
-- worker-general: só o necessário para alertas de vencimento.
GRANT SELECT (id, company_id, establishment_id, not_after, status) ON certificates TO fiscal_general;
--> statement-breakpoint

-- ===================================================================================
-- 6. RLS habilitado e forçado nas tabelas de empresa.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON audit_log
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON audit_chain_heads
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE certificates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON certificates
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
