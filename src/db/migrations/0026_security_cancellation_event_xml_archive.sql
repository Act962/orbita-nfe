-- Arquivamento do XML do evento de cancelamento (ADR-0049, mesmo desenho do ADR-0048). Escrito à mão
-- e revisado.
--
-- O worker-fiscal grava o SHA-256 junto com o XML do evento (na mesma transação do REGISTERED) e,
-- depois de gravar no bucket com Object Lock e conferir a releitura, a chave, a data e a retenção.
-- Tudo é gravado uma única vez.

-- ===================================================================================
-- 1. Integridade (NOT VALID pelo mesmo motivo da 0024: eventos antigos só em desenvolvimento).
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT ck_service_invoice_cancellations_event_sha256 CHECK ((event_xml IS NULL) = (event_xml_sha256 IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT ck_service_invoice_cancellations_event_sha256_format CHECK (event_xml_sha256 IS NULL OR event_xml_sha256 ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT ck_service_invoice_cancellations_event_archive CHECK (
    (event_xml_object_key IS NULL) = (event_xml_archived_at IS NULL)
    AND (event_xml_object_key IS NULL) = (event_xml_retain_until IS NULL)
    AND (event_xml_object_key IS NULL OR (event_xml IS NOT NULL AND event_xml_sha256 IS NOT NULL
         AND event_xml_object_key LIKE '%' || event_xml_sha256 || '%')));
--> statement-breakpoint

-- ===================================================================================
-- 2. Guarda do cancelamento (cópia da 0018 + colunas do arquivamento, gravadas uma vez).
CREATE OR REPLACE FUNCTION service_invoice_cancellations_guard() RETURNS trigger
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
     OR (OLD.event_xml_sha256 IS NOT NULL AND NEW.event_xml_sha256 IS DISTINCT FROM OLD.event_xml_sha256)
     OR (OLD.event_xml_object_key IS NOT NULL AND NEW.event_xml_object_key IS DISTINCT FROM OLD.event_xml_object_key)
     OR (OLD.event_xml_archived_at IS NOT NULL AND NEW.event_xml_archived_at IS DISTINCT FROM OLD.event_xml_archived_at)
     OR (OLD.event_xml_retain_until IS NOT NULL AND NEW.event_xml_retain_until IS DISTINCT FROM OLD.event_xml_retain_until)
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'dado do cancelamento já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_write_once';
  END IF;
  -- O hash só nasce junto com o XML do evento.
  IF OLD.event_xml_sha256 IS NULL AND NEW.event_xml_sha256 IS NOT NULL AND OLD.event_xml IS NOT NULL THEN
    RAISE EXCEPTION 'o hash do XML do evento é gravado junto com ele'
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

-- ===================================================================================
-- 3. Privilégios mínimos: só o worker-fiscal grava; API e operador veem a situação, sem o XML.
GRANT UPDATE (event_xml_sha256, event_xml_object_key, event_xml_archived_at, event_xml_retain_until)
  ON service_invoice_cancellations TO fiscal_worker;
--> statement-breakpoint
GRANT SELECT (event_xml_sha256, event_xml_archived_at, event_xml_retain_until) ON service_invoice_cancellations TO fiscal_api, fiscal_admin;
