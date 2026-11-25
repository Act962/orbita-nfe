-- Situação da NFS-e gerada (infNFSe/cStat, tipo TStat do XSD oficial), ADR-0054. Escrito à mão e revisado.
--
-- O worker-fiscal lê o cStat do XML autorizado e grava os dois na mesma transação. Gravado uma vez.

-- ===================================================================================
-- 1. Integridade: três dígitos, e só com o XML autorizado.
ALTER TABLE service_invoices
  ADD CONSTRAINT ck_service_invoices_status_code CHECK (nfse_status_code IS NULL OR (nfse_status_code ~ '^[0-9]{3}$' AND nfse_xml IS NOT NULL));
--> statement-breakpoint

-- ===================================================================================
-- 2. Guarda do documento (cópia da 0024 + o cStat, gravado uma vez e só junto com o XML).
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
     OR NEW.routing_table_version IS DISTINCT FROM OLD.routing_table_version
     OR NEW.substitutes_invoice_id IS DISTINCT FROM OLD.substitutes_invoice_id
     OR NEW.substitution_access_key IS DISTINCT FROM OLD.substitution_access_key
     OR NEW.substitution_reason_code IS DISTINCT FROM OLD.substitution_reason_code
     OR NEW.substitution_reason_text IS DISTINCT FROM OLD.substitution_reason_text THEN
    RAISE EXCEPTION 'identidade do documento fiscal é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_immutable';
  END IF;
  -- Gravados uma única vez: o XML assinado é o que foi (ou pode ter sido) transmitido.
  IF (OLD.signed_dps IS NOT NULL AND NEW.signed_dps IS DISTINCT FROM OLD.signed_dps)
     OR (OLD.signed_dps_sha256 IS NOT NULL AND NEW.signed_dps_sha256 IS DISTINCT FROM OLD.signed_dps_sha256)
     OR (OLD.layout_package IS NOT NULL AND NEW.layout_package IS DISTINCT FROM OLD.layout_package)
     OR (OLD.nfse_access_key IS NOT NULL AND NEW.nfse_access_key IS DISTINCT FROM OLD.nfse_access_key)
     OR (OLD.nfse_xml IS NOT NULL AND NEW.nfse_xml IS DISTINCT FROM OLD.nfse_xml)
     OR (OLD.nfse_xml_sha256 IS NOT NULL AND NEW.nfse_xml_sha256 IS DISTINCT FROM OLD.nfse_xml_sha256)
     OR (OLD.nfse_status_code IS NOT NULL AND NEW.nfse_status_code IS DISTINCT FROM OLD.nfse_status_code)
     OR (OLD.nfse_xml_object_key IS NOT NULL AND NEW.nfse_xml_object_key IS DISTINCT FROM OLD.nfse_xml_object_key)
     OR (OLD.nfse_xml_archived_at IS NOT NULL AND NEW.nfse_xml_archived_at IS DISTINCT FROM OLD.nfse_xml_archived_at)
     OR (OLD.nfse_xml_retain_until IS NOT NULL AND NEW.nfse_xml_retain_until IS DISTINCT FROM OLD.nfse_xml_retain_until)
     OR (OLD.substituted_by_invoice_id IS NOT NULL AND NEW.substituted_by_invoice_id IS DISTINCT FROM OLD.substituted_by_invoice_id) THEN
    RAISE EXCEPTION 'dado fiscal já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_write_once';
  END IF;
  -- O hash só nasce junto com o XML: ninguém "carimba" um XML gravado antes.
  IF OLD.nfse_xml_sha256 IS NULL AND NEW.nfse_xml_sha256 IS NOT NULL AND OLD.nfse_xml IS NOT NULL THEN
    RAISE EXCEPTION 'o hash do XML autorizado é gravado junto com ele'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_write_once';
  END IF;
  -- O cStat também só nasce junto com o XML (ADR-0054).
  IF OLD.nfse_status_code IS NULL AND NEW.nfse_status_code IS NOT NULL AND OLD.nfse_xml IS NOT NULL THEN
    RAISE EXCEPTION 'o cStat da NFS-e é gravado junto com o XML'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_write_once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('AUTHORIZED', 'REJECTED', 'UNKNOWN', 'PENDING', 'FAILED'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('AUTHORIZED', 'PENDING'))
    OR (OLD.status = 'AUTHORIZED' AND NEW.status IN ('CANCELLED', 'SUBSTITUTED'))
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
  -- SUBSTITUTED só com a substituta já autorizada (ADR-0036 item 5).
  IF NEW.status = 'SUBSTITUTED' AND OLD.status <> 'SUBSTITUTED' AND NOT EXISTS (
       SELECT 1 FROM service_invoices s
        WHERE s.company_id = OLD.company_id AND s.id = NEW.substituted_by_invoice_id
          AND s.substitutes_invoice_id = OLD.id AND s.status = 'AUTHORIZED') THEN
    RAISE EXCEPTION 'nota só vira SUBSTITUTED com a substituta autorizada'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_substituted_by_authorized';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint

-- ===================================================================================
-- 3. Privilégios: só o worker-fiscal grava; a API já lê a tabela inteira; o operador vê o código.
GRANT UPDATE (nfse_status_code) ON service_invoices TO fiscal_worker;
--> statement-breakpoint
GRANT SELECT (nfse_status_code) ON service_invoices TO fiscal_admin;