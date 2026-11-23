-- Substituição pelo canal da DSF e E0065 no banco (ADR-0046). Escrito à mão e revisado.
--
-- A 0020 só aceitava substituta de nota do canal nacional. Agora a substituta pode ser de nota de
-- qualquer canal, desde que saia pelo MESMO canal da original: E0065 do Anexo I ("não poderá
-- ocorrer a substituição de NFS-e que tenha sido gerada em ambientes geradores diferentes").
-- Nota sem canal gravado (anterior à 0015) conta como canal nacional, como na aplicação.
-- O resto da verificação é o mesmo da 0020.
CREATE OR REPLACE FUNCTION service_invoices_substitution_check() RETURNS trigger
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
          AND o.status = 'AUTHORIZED'
          AND COALESCE(o.routing_channel, 'NATIONAL_SEFIN') = COALESCE(NEW.routing_channel, 'NATIONAL_SEFIN')
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
