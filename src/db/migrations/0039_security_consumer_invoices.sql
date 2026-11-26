-- Segurança da NFC-e (ADR-0072, ADR-0011, ADR-0022). Escrito à mão e revisado, no molde da 0012 (NFS-e).

-- ===================================================================================
-- 1. Integridade referencial: tudo da MESMA empresa.
ALTER TABLE consumer_invoices
  ADD CONSTRAINT fk_consumer_invoices_establishment FOREIGN KEY (company_id, establishment_id)
  REFERENCES establishments (company_id, id);
--> statement-breakpoint
ALTER TABLE consumer_invoices
  ADD CONSTRAINT fk_consumer_invoices_series FOREIGN KEY (company_id, series_id)
  REFERENCES document_series (company_id, id);
--> statement-breakpoint
ALTER TABLE consumer_invoices
  ADD CONSTRAINT fk_consumer_invoices_client_application FOREIGN KEY (client_application_id)
  REFERENCES client_applications (id);
--> statement-breakpoint
ALTER TABLE consumer_invoice_attempts
  ADD CONSTRAINT fk_consumer_invoice_attempts_invoice FOREIGN KEY (company_id, invoice_id)
  REFERENCES consumer_invoices (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Documento: identidade e dados do pedido imutáveis; resultado do autorizador gravado uma única
--    vez; transições só as da máquina de estados (domain/consumer-invoice.ts). Ninguém apaga.
CREATE FUNCTION consumer_invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'documento fiscal não pode ser apagado'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_consumer_invoices_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     OR NEW.client_application_id IS DISTINCT FROM OLD.client_application_id
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.series_id IS DISTINCT FROM OLD.series_id
     OR NEW.series IS DISTINCT FROM OLD.series OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.numeric_code IS DISTINCT FROM OLD.numeric_code OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade do documento fiscal é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoices_immutable';
  END IF;
  -- Gravados uma única vez: o que o autorizador respondeu não muda depois.
  IF (OLD.access_key IS NOT NULL AND NEW.access_key IS DISTINCT FROM OLD.access_key)
     OR (OLD.protocol_number IS NOT NULL AND NEW.protocol_number IS DISTINCT FROM OLD.protocol_number)
     OR (OLD.authorizer_status_code IS NOT NULL AND NEW.authorizer_status_code IS DISTINCT FROM OLD.authorizer_status_code)
     OR (OLD.nfe_proc_xml IS NOT NULL AND NEW.nfe_proc_xml IS DISTINCT FROM OLD.nfe_proc_xml)
     OR (OLD.nfe_proc_xml_sha256 IS NOT NULL AND NEW.nfe_proc_xml_sha256 IS DISTINCT FROM OLD.nfe_proc_xml_sha256) THEN
    RAISE EXCEPTION 'dado fiscal já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoices_write_once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'FAILED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('AUTHORIZED', 'REJECTED', 'DENIED', 'UNKNOWN', 'PENDING', 'FAILED'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('AUTHORIZED', 'DENIED', 'PENDING'))
  ) THEN
    RAISE EXCEPTION 'transição de NFC-e inválida: % → %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoices_transition';
  END IF;
  -- FAILED só antes de qualquer transmissão: nenhuma tentativa pode ter chegado a SENDING.
  IF NEW.status = 'FAILED' AND OLD.status <> 'FAILED' AND EXISTS (
       SELECT 1 FROM consumer_invoice_attempts a WHERE a.invoice_id = OLD.id AND a.sending_at IS NOT NULL) THEN
    RAISE EXCEPTION 'documento que pode ter sido transmitido não pode ir para FAILED'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoices_failed_after_send';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consumer_invoices_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_consumer_invoices_guard BEFORE UPDATE OR DELETE ON consumer_invoices
  FOR EACH ROW EXECUTE FUNCTION consumer_invoices_guard();
--> statement-breakpoint
CREATE TRIGGER trg_consumer_invoices_no_truncate BEFORE TRUNCATE ON consumer_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION consumer_invoices_guard();
--> statement-breakpoint

-- ===================================================================================
-- 3. Tentativas: PREPARED → SENDING → CLOSED (ou PREPARED → CLOSED na recuperação de queda).
--    O XML assinado, a chave e o digest de cada tentativa nunca mudam: são a prova do que saiu.
--    Uma tentativa nova só nasce se a anterior estiver fechada e a nota voltou a PENDING (aplicação),
--    e o índice uq_consumer_invoice_attempts_open garante no máximo uma aberta.
CREATE FUNCTION consumer_invoice_attempts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'tentativa de transmissão não pode ser apagada'
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_consumer_invoice_attempts_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.access_key IS DISTINCT FROM OLD.access_key OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.signed_xml IS DISTINCT FROM OLD.signed_xml OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.digest_value IS DISTINCT FROM OLD.digest_value OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at
     OR (OLD.sending_at IS NOT NULL AND NEW.sending_at IS DISTINCT FROM OLD.sending_at)
     OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
         OR NEW.closed_at IS DISTINCT FROM OLD.closed_at)) THEN
    RAISE EXCEPTION 'tentativa de transmissão: dado gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoice_attempts_immutable';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'PREPARED' AND NEW.state IN ('SENDING', 'CLOSED'))
    OR (OLD.state = 'SENDING' AND NEW.state = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'transição de tentativa inválida: % → %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoice_attempts_transition';
  END IF;
  -- Tentativa que chegou a SENDING nunca é fechada como "não enviada" pela recuperação.
  IF OLD.sending_at IS NOT NULL AND NEW.outcome = 'RECOVERED_NOT_SENT' THEN
    RAISE EXCEPTION 'tentativa em SENDING não pode ser dada como não enviada'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoice_attempts_not_sent_after_sending';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consumer_invoice_attempts_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_consumer_invoice_attempts_guard BEFORE UPDATE OR DELETE ON consumer_invoice_attempts
  FOR EACH ROW EXECUTE FUNCTION consumer_invoice_attempts_guard();
--> statement-breakpoint
CREATE TRIGGER trg_consumer_invoice_attempts_no_truncate BEFORE TRUNCATE ON consumer_invoice_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION consumer_invoice_attempts_guard();
--> statement-breakpoint

-- ===================================================================================
-- 4. Privilégios mínimos.
--    API: aceita (INSERT das colunas do pedido) e consulta. Não muda estado.
--    worker-fiscal: monta, assina, transmite e reconcilia (UPDATE só das colunas de processamento).
--    worker-general: nada.
REVOKE ALL ON consumer_invoices, consumer_invoice_attempts FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT (id, company_id, establishment_id, client_application_id, environment, series_id, series, number,
  numeric_code, idempotency_key, request_hash, external_reference, payload) ON consumer_invoices TO fiscal_api;
--> statement-breakpoint
GRANT SELECT, UPDATE (status, lease_until, access_key, protocol_number, authorizer_status_code, nfe_proc_xml,
  nfe_proc_xml_sha256, authorized_at, rejection_code, rejection_message, failure_code, updated_at) ON consumer_invoices TO fiscal_worker;
--> statement-breakpoint
-- A API lê as tentativas para o diagnóstico, mas nunca o XML assinado (que vai no download da nota autorizada).
GRANT SELECT (id, company_id, invoice_id, seq, state, access_key, issued_at, payload_sha256, prepared_at, sending_at,
  closed_at, outcome, outcome_code, lookups, first_not_found_at, consecutive_lookup_errors) ON consumer_invoice_attempts TO fiscal_api;
--> statement-breakpoint
GRANT SELECT, INSERT (id, company_id, invoice_id, seq, access_key, issued_at, signed_xml, payload_sha256, digest_value)
  ON consumer_invoice_attempts TO fiscal_worker;
--> statement-breakpoint
GRANT UPDATE (state, sending_at, closed_at, outcome, outcome_code, lookups, first_not_found_at, consecutive_lookup_errors)
  ON consumer_invoice_attempts TO fiscal_worker;
--> statement-breakpoint

-- ===================================================================================
-- 5. RLS habilitado e forçado.
ALTER TABLE consumer_invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consumer_invoices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON consumer_invoices
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE consumer_invoice_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consumer_invoice_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON consumer_invoice_attempts
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
