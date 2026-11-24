-- Conferência periódica dos XML arquivados no bucket (ADR-0051). Escrito à mão e revisado.
--
-- Uma linha por objeto conferido, só com a situação: quando bateu, quando falhou e o código da
-- falha. Nenhum XML, nenhum dado pessoal. Ninguém apaga: a linha é o histórico mínimo do alerta.

-- ===================================================================================
-- 1. Integridade: a linha é da MESMA empresa do documento (FK composta por tipo não existe; a
--    empresa vem do contexto da transação, e o RLS impede gravar em outra).
ALTER TABLE archived_xml_checks
  ADD CONSTRAINT fk_archived_xml_checks_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Privilégios mínimos: só o worker-fiscal (que tem a credencial do bucket) confere e grava.
--    O operador vê a situação para acompanhar o alerta. A API não lê nem grava.
REVOKE ALL ON archived_xml_checks FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (last_verified_at, last_failed_at, failure_code) ON archived_xml_checks TO fiscal_worker;
--> statement-breakpoint
GRANT SELECT ON archived_xml_checks TO fiscal_admin;
--> statement-breakpoint

-- ===================================================================================
-- 3. RLS habilitado e forçado.
ALTER TABLE archived_xml_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE archived_xml_checks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON archived_xml_checks
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
