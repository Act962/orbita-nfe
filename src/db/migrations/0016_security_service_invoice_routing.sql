-- Roteamento da NFS-e (ADR-0028). Escrito à mão e revisado.
--
-- O canal e a versão da tabela são gravados na aceitação e nunca mudam: consulta, cancelamento e
-- substituição usam o mesmo canal (ADR-0028 item 3). Notas anteriores a esta migration ficam com
-- as colunas nulas.

-- ===================================================================================
-- 1. Canais conhecidos.
ALTER TABLE service_invoices ADD CONSTRAINT ck_service_invoices_routing_channel
  CHECK (routing_channel IS NULL OR routing_channel IN ('NATIONAL_SEFIN', 'MUNICIPAL_TERESINA_DSF'));
--> statement-breakpoint
ALTER TABLE service_invoices ADD CONSTRAINT ck_service_invoices_routing_pair
  CHECK ((routing_channel IS NULL) = (routing_table_version IS NULL));
--> statement-breakpoint

-- ===================================================================================
-- 2. A API grava as duas colunas na aceitação (como o resto do pedido).
GRANT INSERT (routing_channel, routing_table_version) ON service_invoices TO fiscal_api;
--> statement-breakpoint

-- ===================================================================================
-- 3. Guarda do documento: as duas colunas entram na identidade imutável (cópia da 0012 + 2 linhas).
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
