-- Arquivamento do XML autorizado da NFC-e (ADR-0074, molde da 0024 da NFS-e). Escrito à mão e revisado.
--
-- O worker-fiscal grava o nfeProc e o SHA-256 juntos na autorização; depois de gravar o objeto no
-- bucket com Object Lock e conferir a releitura, grava a chave, a data e a retenção. Tudo uma vez.

-- ===================================================================================
-- 1. Guarda do documento (cópia da 0039 + colunas do arquivamento, gravadas uma vez).
CREATE OR REPLACE FUNCTION consumer_invoices_guard() RETURNS trigger
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
  -- Gravados uma única vez: o que o autorizador respondeu e onde o XML foi arquivado não mudam depois.
  IF (OLD.access_key IS NOT NULL AND NEW.access_key IS DISTINCT FROM OLD.access_key)
     OR (OLD.protocol_number IS NOT NULL AND NEW.protocol_number IS DISTINCT FROM OLD.protocol_number)
     OR (OLD.authorizer_status_code IS NOT NULL AND NEW.authorizer_status_code IS DISTINCT FROM OLD.authorizer_status_code)
     OR (OLD.nfe_proc_xml IS NOT NULL AND NEW.nfe_proc_xml IS DISTINCT FROM OLD.nfe_proc_xml)
     OR (OLD.nfe_proc_xml_sha256 IS NOT NULL AND NEW.nfe_proc_xml_sha256 IS DISTINCT FROM OLD.nfe_proc_xml_sha256)
     OR (OLD.nfe_proc_xml_object_key IS NOT NULL AND NEW.nfe_proc_xml_object_key IS DISTINCT FROM OLD.nfe_proc_xml_object_key)
     OR (OLD.nfe_proc_xml_archived_at IS NOT NULL AND NEW.nfe_proc_xml_archived_at IS DISTINCT FROM OLD.nfe_proc_xml_archived_at)
     OR (OLD.nfe_proc_xml_retain_until IS NOT NULL AND NEW.nfe_proc_xml_retain_until IS DISTINCT FROM OLD.nfe_proc_xml_retain_until) THEN
    RAISE EXCEPTION 'dado fiscal já gravado não pode mudar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_consumer_invoices_write_once';
  END IF;
  -- O hash só nasce junto com o XML: ninguém "carimba" um XML gravado antes.
  IF OLD.nfe_proc_xml_sha256 IS NULL AND NEW.nfe_proc_xml_sha256 IS NOT NULL AND OLD.nfe_proc_xml IS NOT NULL THEN
    RAISE EXCEPTION 'o hash do XML autorizado é gravado junto com ele'
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

-- ===================================================================================
-- 2. Privilégios mínimos: só o worker-fiscal grava o arquivamento (a API já lê a tabela inteira).
GRANT UPDATE (nfe_proc_xml_object_key, nfe_proc_xml_archived_at, nfe_proc_xml_retain_until) ON consumer_invoices TO fiscal_worker;
