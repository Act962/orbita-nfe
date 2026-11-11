-- Segurança dos avisos de vencimento de certificado (doc 13 §4, ADR-0021, ADR-0011).
-- Escrito à mão e revisado.

-- ===================================================================================
-- 1. Integridade: o aviso só aponta para certificado da MESMA empresa.
ALTER TABLE certificates ADD CONSTRAINT uq_certificates_company_id UNIQUE (company_id, id);
--> statement-breakpoint
ALTER TABLE certificate_expiry_notices
  ADD CONSTRAINT fk_certificate_expiry_notices_certificate FOREIGN KEY (company_id, certificate_id)
  REFERENCES certificates (company_id, id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Privilégios mínimos. Só o worker-general registra e lê avisos (nunca altera nem apaga).
--    Para publicar `certificate.expiring`/`certificate.expired`, ele passa a inserir no outbox
--    (o outbox continua append-only para todos, migration 0005).
REVOKE ALL ON certificate_expiry_notices FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON certificate_expiry_notices TO fiscal_general;
--> statement-breakpoint
GRANT INSERT ON outbox_events TO fiscal_general;
--> statement-breakpoint

-- ===================================================================================
-- 3. RLS habilitado e forçado.
ALTER TABLE certificate_expiry_notices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE certificate_expiry_notices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON certificate_expiry_notices
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
