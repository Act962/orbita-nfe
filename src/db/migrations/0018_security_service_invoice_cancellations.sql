-- Cancelamento de NFS-e (ADR-0035). Escrito à mão e revisado.

-- ===================================================================================
-- 1. Integridade: o pedido é da MESMA empresa da nota e da aplicação que pediu.
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT fk_service_invoice_cancellations_invoice FOREIGN KEY (company_id, invoice_id)
  REFERENCES service_invoices (company_id, id);
--> statement-breakpoint
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT fk_service_invoice_cancellations_client_application FOREIGN KEY (client_application_id)
  REFERENCES client_applications (id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Nota: nova transição AUTHORIZED → CANCELLED (cópia da guarda da 0016 + 1 linha).
CREATE OR REPLACE FUNCTION service_invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'documento fiscal não pode ser apagado'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_service_invoices_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     OR NEW.client_application_id IS DISTINCT FROM OLD.client_application_id
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.series IS DISTINCT FROM OLD.series OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.dps_id IS DISTINCT FROM OLD.dps_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.routing_channel IS DISTINCT FROM OLD.routing_channel
     OR NEW.routing_table_version IS DISTINCT FROM OLD.routing_table_version THEN
    RAISE EXCEPTION 'identidade do documento fiscal é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_immutable';
  END IF;
  -- Gravados uma única vez: o XML assinado é o que foi (ou pode ter sido) transmitido.
  IF (OLD.signed_dps IS NOT NULL AND NEW.signed_dps IS DISTINCT FROM OLD.signed_dps)
     OR (OLD.signed_dps_sha256 IS NOT NULL AND NEW.signed_dps_sha256 IS DISTINCT FROM OLD.signed_dps_sha256)
     OR (OLD.layout_package IS NOT NULL AND NEW.layout_package IS DISTINCT FROM OLD.layout_package)
     OR (OLD.nfse_access_key IS NOT NULL AND NEW.nfse_access_key IS DISTINCT FROM OLD.nfse_access_key)
     OR (OLD.nfse_xml IS NOT NULL AND NEW.nfse_xml IS DISTINCT FROM OLD.nfse_xml) THEN
    RAISE EXCEPTION 'dado fiscal já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_write_once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('AUTHORIZED', 'REJECTED', 'UNKNOWN', 'PENDING', 'FAILED'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('AUTHORIZED', 'PENDING'))
    OR (OLD.status = 'AUTHORIZED' AND NEW.status = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'transição de NFS-e inválida: % → %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_transition';
  END IF;
  -- FAILED só antes de qualquer transmissão: nenhuma tentativa pode ter chegado a SENDING.
  IF NEW.status = 'FAILED' AND OLD.status <> 'FAILED' AND EXISTS (
       SELECT 1 FROM service_invoice_attempts a WHERE a.invoice_id = OLD.id AND a.sending_at IS NOT NULL) THEN
    RAISE EXCEPTION 'documento que pode ter sido transmitido não pode ir para FAILED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_failed_after_send';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ===================================================================================
-- 3. Cancelamento: pedido imutável; XML assinado e XML do evento gravados uma vez;
--    transições da máquina de estados (domain/cancellation.ts); FAILED só sem nenhum envio;
--    ninguém apaga.
CREATE FUNCTION service_invoice_cancellations_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'pedido de cancelamento não pode ser apagado'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_service_invoice_cancellations_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.client_application_id IS DISTINCT FROM OLD.client_application_id
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.reason_text IS DISTINCT FROM OLD.reason_text OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pedido de cancelamento é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_immutable';
  END IF;
  IF (OLD.signed_xml IS NOT NULL AND NEW.signed_xml IS DISTINCT FROM OLD.signed_xml)
     OR (OLD.signed_sha256 IS NOT NULL AND NEW.signed_sha256 IS DISTINCT FROM OLD.signed_sha256)
     OR (OLD.layout_package IS NOT NULL AND NEW.layout_package IS DISTINCT FROM OLD.layout_package)
     OR (OLD.event_xml IS NOT NULL AND NEW.event_xml IS DISTINCT FROM OLD.event_xml)
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'dado do cancelamento já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_write_once';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('PROCESSING', 'FAILED'))
    OR (OLD.state = 'PROCESSING' AND NEW.state IN ('REGISTERED', 'REJECTED', 'UNKNOWN', 'PENDING', 'FAILED'))
    OR (OLD.state = 'UNKNOWN' AND NEW.state IN ('REGISTERED', 'PENDING'))
  ) THEN
    RAISE EXCEPTION 'transição de cancelamento inválida: % → %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_transition';
  END IF;
  IF NEW.state = 'FAILED' AND OLD.state <> 'FAILED' AND OLD.attempts > 0 THEN
    RAISE EXCEPTION 'cancelamento que pode ter sido enviado não pode ir para FAILED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_failed_after_send';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION service_invoice_cancellations_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_service_invoice_cancellations_guard BEFORE UPDATE OR DELETE ON service_invoice_cancellations
  FOR EACH ROW EXECUTE FUNCTION service_invoice_cancellations_guard();
--> statement-breakpoint
CREATE TRIGGER trg_service_invoice_cancellations_no_truncate BEFORE TRUNCATE ON service_invoice_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION service_invoice_cancellations_guard();
--> statement-breakpoint

-- ===================================================================================
-- 4. Privilégios mínimos (mesmo desenho da nota):
--    API: grava o pedido e lê (sem os XML). worker-fiscal: processa. Operador: só metadados.
REVOKE ALL ON service_invoice_cancellations FROM PUBLIC;
--> statement-breakpoint
GRANT INSERT (id, company_id, invoice_id, client_application_id, request_hash, reason_code, reason_text)
  ON service_invoice_cancellations TO fiscal_api;
--> statement-breakpoint
GRANT SELECT (id, company_id, invoice_id, client_application_id, request_hash, reason_code, reason_text, state, lease_until,
  signed_sha256, sending_at, attempts, lookups, first_not_found_at, consecutive_lookup_errors, outcome_code, rejection_message,
  registered_at, failure_code, created_at, updated_at) ON service_invoice_cancellations TO fiscal_api, fiscal_admin;
--> statement-breakpoint
GRANT SELECT, UPDATE (state, lease_until, signed_xml, signed_sha256, layout_package, sending_at, attempts, lookups, first_not_found_at,
  consecutive_lookup_errors, outcome_code, rejection_message, event_xml, registered_at, failure_code, updated_at)
  ON service_invoice_cancellations TO fiscal_worker;
--> statement-breakpoint

-- ===================================================================================
-- 5. RLS habilitado e forçado.
ALTER TABLE service_invoice_cancellations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_invoice_cancellations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON service_invoice_cancellations
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
