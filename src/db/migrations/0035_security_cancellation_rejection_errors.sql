-- Todos os erros da rejeição do evento de cancelamento (ADR-0059). Escrito à mão e revisado.
--
-- O worker-fiscal grava a lista junto com o primeiro código (outcome_code), na mesma transação.

-- ===================================================================================
-- 1. Integridade: lista JSON não vazia, e só num pedido REJECTED com código.
ALTER TABLE service_invoice_cancellations
  ADD CONSTRAINT ck_service_invoice_cancellations_rejection_errors CHECK (
    rejection_errors IS NULL
    OR (jsonb_typeof(rejection_errors) = 'array' AND jsonb_array_length(rejection_errors) > 0 AND state = 'REJECTED' AND outcome_code IS NOT NULL)
  );
--> statement-breakpoint

-- ===================================================================================
-- 2. Privilégios, como rejection_message (migration 0018): o worker-fiscal grava; a API e o
--    operador leem.
GRANT SELECT, UPDATE (rejection_errors) ON service_invoice_cancellations TO fiscal_worker;
--> statement-breakpoint
GRANT SELECT (rejection_errors) ON service_invoice_cancellations TO fiscal_api, fiscal_admin;
