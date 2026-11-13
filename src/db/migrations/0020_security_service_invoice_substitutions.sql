-- Substituição de NFS-e (ADR-0036). Escrito à mão e revisado.
--
-- A substituta é uma NFS-e nova que aponta para a original. A original só vira SUBSTITUTED
-- quando a substituta é AUTHORIZED, na mesma transação. As travas desta migration são a defesa em
-- profundidade: a aplicação já confere tudo isso, e serializa os pedidos sobre a mesma nota.

-- ===================================================================================
-- 1. Integridade: original e substituta são da MESMA empresa.
ALTER TABLE service_invoices
  ADD CONSTRAINT fk_service_invoices_substitutes FOREIGN KEY (company_id, substitutes_invoice_id)
  REFERENCES service_invoices (company_id, id);
--> statement-breakpoint
ALTER TABLE service_invoices
  ADD CONSTRAINT fk_service_invoices_substituted_by FOREIGN KEY (company_id, substituted_by_invoice_id)
  REFERENCES service_invoices (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Aceite da substituta: a original tem de estar AUTHORIZED, no canal nacional, no mesmo
--    estabelecimento, ambiente e aplicação, com a chave igual a `chSubstda`, e sem pedido de
--    cancelamento ativo (E0042, E0046 e E0065 do Anexo I, e ADR-0036 item 3).
CREATE FUNCTION service_invoices_substitution_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.substitutes_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.substituted_by_invoice_id IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM service_invoices o
        WHERE o.company_id = NEW.company_id AND o.id = NEW.substitutes_invoice_id
          AND o.status = 'AUTHORIZED' AND o.routing_channel = 'NATIONAL_SEFIN'
          AND o.establishment_id = NEW.establishment_id AND o.environment = NEW.environment
          AND o.client_application_id = NEW.client_application_id
          AND o.nfse_access_key = NEW.substitution_access_key) THEN
    RAISE EXCEPTION 'a nota original não pode ser substituída por esta nota'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_substitution_original';
  END IF;
  IF EXISTS (SELECT 1 FROM service_invoice_cancellations c
              WHERE c.invoice_id = NEW.substitutes_invoice_id AND c.state NOT IN ('REJECTED', 'FAILED')) THEN
    RAISE EXCEPTION 'a nota original tem pedido de cancelamento ativo'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoices_substitution_cancellation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION service_invoices_substitution_check() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_service_invoices_substitution_check BEFORE INSERT ON service_invoices
  FOR EACH ROW EXECUTE FUNCTION service_invoices_substitution_check();
--> statement-breakpoint

-- O inverso: não se pede cancelamento de nota com substituta viva.
CREATE FUNCTION service_invoice_cancellations_substitution_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM service_invoices s
              WHERE s.company_id = NEW.company_id AND s.substitutes_invoice_id = NEW.invoice_id
                AND s.status NOT IN ('REJECTED', 'FAILED')) THEN
    RAISE EXCEPTION 'a nota tem substituição em andamento ou concluída'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_service_invoice_cancellations_substitution';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION service_invoice_cancellations_substitution_check() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_service_invoice_cancellations_substitution_check BEFORE INSERT ON service_invoice_cancellations
  FOR EACH ROW EXECUTE FUNCTION service_invoice_cancellations_substitution_check();
--> statement-breakpoint

-- ===================================================================================
-- 3. Guarda do documento (cópia da 0018 + substituição):
--    - as colunas da substituta entram na identidade imutável;
--    - `substituted_by_invoice_id` é gravado uma vez;
--    - nova transição AUTHORIZED → SUBSTITUTED, só com uma substituta AUTHORIZED que aponte
--      para esta nota.
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
     OR (OLD.substituted_by_invoice_id IS NOT NULL AND NEW.substituted_by_invoice_id IS DISTINCT FROM OLD.substituted_by_invoice_id) THEN
    RAISE EXCEPTION 'dado fiscal já gravado não pode mudar'
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
-- 4. Privilégios mínimos.
--    API: grava as colunas da substituta no aceite (como o resto do pedido).
--    worker-fiscal: grava na original a substituta autorizada.
--    Operador: vê o vínculo (só identificadores).
GRANT INSERT (substitutes_invoice_id, substitution_access_key, substitution_reason_code, substitution_reason_text)
  ON service_invoices TO fiscal_api;
--> statement-breakpoint
GRANT UPDATE (substituted_by_invoice_id) ON service_invoices TO fiscal_worker;
--> statement-breakpoint
GRANT SELECT (substitutes_invoice_id, substituted_by_invoice_id) ON service_invoices TO fiscal_admin;
