-- Resolução manual de NFS-e em UNKNOWN (ADR-0034, doc 12 §7). Escrito à mão e revisado.
--
-- Princípio: o operador (fiscal_admin) só GRAVA um pedido e lê metadados. Quem muda o estado
-- do documento fiscal continua sendo apenas o worker-fiscal.

-- ===================================================================================
-- 1. Integridade: o pedido é da MESMA empresa do documento.
ALTER TABLE service_invoice_resolutions
  ADD CONSTRAINT fk_service_invoice_resolutions_invoice FOREIGN KEY (company_id, invoice_id)
  REFERENCES service_invoices (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Só se acrescenta: o pedido é imutável e a decisão (REQUESTED → APPLIED | REFUSED) é
--    gravada uma única vez. Ninguém apaga, nem o dono da tabela.
CREATE FUNCTION service_invoice_resolutions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'pedido de resolução não pode ser apagado'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_service_invoice_resolutions_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256
     OR NEW.nfse_xml IS DISTINCT FROM OLD.nfse_xml OR NEW.operator IS DISTINCT FROM OLD.operator
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'pedido de resolução é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_resolutions_immutable';
  END IF;
  IF OLD.state <> 'REQUESTED' OR NEW.state NOT IN ('APPLIED', 'REFUSED') THEN
    RAISE EXCEPTION 'decisão de resolução inválida: % → %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_resolutions_decision';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION service_invoice_resolutions_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_service_invoice_resolutions_guard BEFORE UPDATE OR DELETE ON service_invoice_resolutions
  FOR EACH ROW EXECUTE FUNCTION service_invoice_resolutions_guard();
--> statement-breakpoint
CREATE TRIGGER trg_service_invoice_resolutions_no_truncate BEFORE TRUNCATE ON service_invoice_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION service_invoice_resolutions_guard();
--> statement-breakpoint

-- ===================================================================================
-- 3. Privilégios mínimos.
REVOKE ALL ON service_invoice_resolutions FROM PUBLIC;
--> statement-breakpoint
-- Operador: grava o pedido; lê de volta só os metadados (o XML não).
GRANT INSERT (id, company_id, invoice_id, outcome, reason, evidence_sha256, nfse_xml, operator)
  ON service_invoice_resolutions TO fiscal_admin;
--> statement-breakpoint
GRANT SELECT (id, company_id, invoice_id, outcome, reason, evidence_sha256, operator, requested_at, state, result_code, decided_at)
  ON service_invoice_resolutions TO fiscal_admin;
--> statement-breakpoint
-- worker-fiscal: lê o pedido inteiro e grava a decisão.
GRANT SELECT, UPDATE (state, result_code, decided_at) ON service_invoice_resolutions TO fiscal_worker;
--> statement-breakpoint
-- Operador: lista as notas em UNKNOWN pela idade. Só metadados: sem pedido, sem XML.
GRANT SELECT (id, company_id, establishment_id, environment, series, number, dps_id, status, layout_package,
  nfse_access_key, created_at, updated_at) ON service_invoices TO fiscal_admin;
--> statement-breakpoint
GRANT SELECT ON service_invoice_attempts TO fiscal_admin;
--> statement-breakpoint
-- Operador: enfileira só o job que leva o pedido ao worker-fiscal.
GRANT INSERT ON jobs TO fiscal_admin;
--> statement-breakpoint
CREATE POLICY jobs_admin_enqueue ON jobs FOR INSERT TO fiscal_admin
  WITH CHECK (queue = 'nfse.resolve' AND lane = 'fiscal' AND state = 'queued' AND attempts = 0 AND locked_by IS NULL AND finished_at IS NULL);
--> statement-breakpoint

-- ===================================================================================
-- 4. RLS. Sem política extra: o operador lê e grava SEMPRE no contexto de uma empresa
--    (`--company`), como na verificação da auditoria. Para saber quais empresas olhar, o
--    painel usa a fila (só identificadores), que o operador já lê.
ALTER TABLE service_invoice_resolutions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_invoice_resolutions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON service_invoice_resolutions
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint

-- ===================================================================================
-- 5. Painel de pendências: notas em UNKNOWN.
CREATE INDEX ix_service_invoices_unknown ON service_invoices (updated_at) WHERE status = 'UNKNOWN';
