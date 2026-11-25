-- Todos os erros da rejeição da NFS-e (ADR-0059). Escrito à mão e revisado.
--
-- O worker-fiscal grava a lista junto com o primeiro código (rejection_code), na mesma transação.

-- ===================================================================================
-- 1. Integridade: lista JSON não vazia, e só numa nota com código de rejeição.
ALTER TABLE service_invoices
  ADD CONSTRAINT ck_service_invoices_rejection_errors CHECK (
    rejection_errors IS NULL
    OR (jsonb_typeof(rejection_errors) = 'array' AND jsonb_array_length(rejection_errors) > 0 AND rejection_code IS NOT NULL)
  );
--> statement-breakpoint

-- ===================================================================================
-- 2. Privilégios: só o worker-fiscal grava (como rejection_code e rejection_message, migration 0012);
--    a API já lê a tabela inteira.
GRANT UPDATE (rejection_errors) ON service_invoices TO fiscal_worker;
