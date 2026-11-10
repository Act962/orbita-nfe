-- Segurança da fila, do outbox e dos webhooks (ADR-0030, ADR-0015, ADR-0021, ADR-0011).
-- Escrito à mão e revisado.

-- ===================================================================================
-- 1. Integridade referencial (os schemas Drizzle de um módulo não importam os de outro).
ALTER TABLE outbox_events
  ADD CONSTRAINT fk_outbox_events_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint
-- Alvo das FKs compostas: entrega só referencia evento da MESMA empresa.
ALTER TABLE outbox_events ADD CONSTRAINT uq_outbox_events_company_id UNIQUE (company_id, id);
--> statement-breakpoint
ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT fk_webhook_subscriptions_company FOREIGN KEY (company_id) REFERENCES companies (id);
--> statement-breakpoint
ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT fk_webhook_subscriptions_application FOREIGN KEY (client_application_id) REFERENCES client_applications (id);
--> statement-breakpoint
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT fk_webhook_deliveries_subscription FOREIGN KEY (company_id, subscription_id) REFERENCES webhook_subscriptions (company_id, id);
--> statement-breakpoint
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT fk_webhook_deliveries_event FOREIGN KEY (company_id, event_id) REFERENCES outbox_events (company_id, id);
--> statement-breakpoint
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT fk_webhook_deliveries_redelivery FOREIGN KEY (redelivery_of) REFERENCES webhook_deliveries (id);
--> statement-breakpoint

-- ===================================================================================
-- 2. Outbox append-only para TODOS os papéis (inclusive o dono): o evento é o registro do
--    que foi comunicado aos clientes.
CREATE FUNCTION outbox_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  RAISE EXCEPTION 'outbox_events é append-only'
    USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'ck_outbox_append_only';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_outbox_events_append_only BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_outbox_events_no_truncate BEFORE TRUNCATE ON outbox_events
  FOR EACH STATEMENT EXECUTE FUNCTION outbox_append_only();
--> statement-breakpoint

-- 3. Imutabilidade: identidade da assinatura e da entrega não muda; versão do segredo só sobe;
--    entrega concluída (SUCCEEDED/FAILED) é final (reenvio = nova linha).
CREATE FUNCTION webhook_subscriptions_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.client_application_id IS DISTINCT FROM OLD.client_application_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade da assinatura de webhook é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_webhook_subscriptions_immutable';
  END IF;
  IF NEW.secret_version < OLD.secret_version
     OR (NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext AND NEW.secret_version <= OLD.secret_version) THEN
    RAISE EXCEPTION 'troca de segredo exige versão maior'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_webhook_subscriptions_secret_rotation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION webhook_subscriptions_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_webhook_subscriptions_guard BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION webhook_subscriptions_guard();
--> statement-breakpoint
CREATE FUNCTION webhook_deliveries_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.redelivery_of IS DISTINCT FROM OLD.redelivery_of OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade da entrega de webhook é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_webhook_deliveries_immutable';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'entrega concluída não muda (use reenvio)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_webhook_deliveries_final';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'tentativas não diminuem'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_webhook_deliveries_attempts_monotonic';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION webhook_deliveries_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_webhook_deliveries_guard BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_guard();
--> statement-breakpoint

-- 4. Job: fila, lane, conteúdo e origem são imutáveis (um worker não "move" job para outra lane
--    nem troca o alvo do job).
CREATE FUNCTION jobs_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.queue IS DISTINCT FROM OLD.queue OR NEW.lane IS DISTINCT FROM OLD.lane
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.singleton_key IS DISTINCT FROM OLD.singleton_key
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade do job é imutável'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_jobs_immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_jobs_guard BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_guard();
--> statement-breakpoint

-- ===================================================================================
-- 5. Privilégios mínimos.
REVOKE ALL ON jobs, queue_controls, outbox_events, webhook_subscriptions, webhook_deliveries FROM PUBLIC;
--> statement-breakpoint

-- 5.1 Fila. API: só enfileira, e não lê nenhum job (por isso nunca usa ON CONFLICT: ver
--     transactionalJobScheduler).
GRANT INSERT ON jobs TO fiscal_api, fiscal_worker, fiscal_general;
--> statement-breakpoint
-- Workers: consomem só a própria lane (RLS abaixo) e apagam só concluídos/descartados (retenção).
GRANT SELECT, DELETE, UPDATE (state, attempts, locked_by, lease_until, run_at, last_error, updated_at, finished_at)
  ON jobs TO fiscal_worker, fiscal_general;
--> statement-breakpoint
GRANT SELECT ON queue_controls TO fiscal_worker, fiscal_general;
--> statement-breakpoint
-- Operador: inspeciona, reprocessa, descarta e pausa (CLI ops, auditada).
GRANT SELECT, UPDATE (state, attempts, run_at, last_error, updated_at, finished_at) ON jobs TO fiscal_admin;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON queue_controls TO fiscal_admin;
--> statement-breakpoint

-- 5.2 Outbox: quem muda estado publica; o worker-general só lê.
GRANT SELECT, INSERT ON outbox_events TO fiscal_api, fiscal_worker;
--> statement-breakpoint
GRANT SELECT ON outbox_events TO fiscal_general;
--> statement-breakpoint

-- 5.3 Assinaturas: a API grava o segredo cifrado e NÃO o lê; só o worker-general lê.
GRANT INSERT ON webhook_subscriptions TO fiscal_api;
--> statement-breakpoint
GRANT SELECT (id, company_id, client_application_id, url, event_types, description, status, secret_version, created_at, updated_at)
  ON webhook_subscriptions TO fiscal_api;
--> statement-breakpoint
GRANT UPDATE (url, event_types, description, status, secret_ciphertext, secret_kek_id, secret_version, updated_at)
  ON webhook_subscriptions TO fiscal_api;
--> statement-breakpoint
GRANT SELECT ON webhook_subscriptions TO fiscal_general;
--> statement-breakpoint

-- 5.4 Entregas.
GRANT SELECT, INSERT ON webhook_deliveries TO fiscal_api, fiscal_general;
--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, last_attempt_at, last_http_status, last_error_code, delivered_at, updated_at)
  ON webhook_deliveries TO fiscal_general;
--> statement-breakpoint

-- 5.5 worker-general confere se a aplicação dona da assinatura ainda tem acesso à empresa.
GRANT SELECT (company_id, client_application_id, status) ON company_grants TO fiscal_general;
--> statement-breakpoint
GRANT SELECT (id, status) ON client_applications TO fiscal_general;
--> statement-breakpoint

-- ===================================================================================
-- 6. RLS por empresa (outbox, assinaturas, entregas).
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON outbox_events
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON webhook_subscriptions
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_isolation ON webhook_deliveries
  USING (company_id = app_current_company())
  WITH CHECK (company_id = app_current_company());
--> statement-breakpoint

-- 7. RLS por lane na fila (ADR-0021): o worker-fiscal nunca vê jobs do worker-general e
--    vice-versa. Qualquer papel enfileira em qualquer lane (ex.: o worker-fiscal publica evento
--    que o worker-general distribui), mas só como job novo.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY jobs_enqueue ON jobs FOR INSERT TO fiscal_api, fiscal_worker, fiscal_general
  WITH CHECK (state = 'queued' AND attempts = 0 AND locked_by IS NULL AND finished_at IS NULL);
--> statement-breakpoint
CREATE POLICY jobs_fiscal_read ON jobs FOR SELECT TO fiscal_worker USING (lane = 'fiscal');
--> statement-breakpoint
CREATE POLICY jobs_fiscal_update ON jobs FOR UPDATE TO fiscal_worker USING (lane = 'fiscal') WITH CHECK (lane = 'fiscal');
--> statement-breakpoint
CREATE POLICY jobs_fiscal_purge ON jobs FOR DELETE TO fiscal_worker USING (lane = 'fiscal' AND state IN ('completed', 'discarded'));
--> statement-breakpoint
CREATE POLICY jobs_general_read ON jobs FOR SELECT TO fiscal_general USING (lane = 'general');
--> statement-breakpoint
CREATE POLICY jobs_general_update ON jobs FOR UPDATE TO fiscal_general USING (lane = 'general') WITH CHECK (lane = 'general');
--> statement-breakpoint
CREATE POLICY jobs_general_purge ON jobs FOR DELETE TO fiscal_general USING (lane = 'general' AND state IN ('completed', 'discarded'));
--> statement-breakpoint
CREATE POLICY jobs_admin_read ON jobs FOR SELECT TO fiscal_admin USING (true);
--> statement-breakpoint
CREATE POLICY jobs_admin_update ON jobs FOR UPDATE TO fiscal_admin USING (true) WITH CHECK (true);
