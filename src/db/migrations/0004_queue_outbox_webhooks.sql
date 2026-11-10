CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_http_status" integer,
	"last_error_code" text,
	"delivered_at" timestamp with time zone,
	"redelivery_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_webhook_deliveries_status" CHECK ("webhook_deliveries"."status" in ('PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "ck_webhook_deliveries_attempts" CHECK ("webhook_deliveries"."attempts" >= 0),
	CONSTRAINT "ck_webhook_deliveries_error" CHECK ("webhook_deliveries"."last_error_code" is null or length("webhook_deliveries"."last_error_code") <= 64)
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"client_application_id" uuid NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_kek_id" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_webhook_subscriptions_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "ck_webhook_subscriptions_status" CHECK ("webhook_subscriptions"."status" in ('ACTIVE', 'DISABLED')),
	CONSTRAINT "ck_webhook_subscriptions_event_types" CHECK (cardinality("webhook_subscriptions"."event_types") between 1 and 20),
	CONSTRAINT "ck_webhook_subscriptions_url" CHECK (length("webhook_subscriptions"."url") <= 2048),
	CONSTRAINT "ck_webhook_subscriptions_secret_version" CHECK ("webhook_subscriptions"."secret_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"lane" text NOT NULL,
	"payload" jsonb NOT NULL,
	"singleton_key" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"locked_by" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_jobs_state" CHECK ("jobs"."state" in ('queued', 'active', 'completed', 'dead', 'discarded')),
	CONSTRAINT "ck_jobs_lane" CHECK ("jobs"."lane" in ('fiscal', 'general')),
	CONSTRAINT "ck_jobs_attempts" CHECK ("jobs"."attempts" >= 0 and "jobs"."max_attempts" >= 1),
	CONSTRAINT "ck_jobs_last_error" CHECK ("jobs"."last_error" is null or length("jobs"."last_error") <= 200)
);
--> statement-breakpoint
CREATE TABLE "queue_controls" (
	"queue" text PRIMARY KEY NOT NULL,
	"paused" boolean NOT NULL,
	"reason" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"correlation_id" text,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_deliveries_original" ON "webhook_deliveries" USING btree ("subscription_id","event_id") WHERE "webhook_deliveries"."redelivery_of" is null;--> statement-breakpoint
CREATE INDEX "ix_webhook_deliveries_subscription" ON "webhook_deliveries" USING btree ("company_id","subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_webhook_deliveries_event" ON "webhook_deliveries" USING btree ("company_id","event_id");--> statement-breakpoint
CREATE INDEX "ix_webhook_subscriptions_application" ON "webhook_subscriptions" USING btree ("company_id","client_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_singleton" ON "jobs" USING btree ("queue","singleton_key") WHERE "jobs"."singleton_key" is not null and "jobs"."state" in ('queued', 'active');--> statement-breakpoint
CREATE INDEX "ix_jobs_ready" ON "jobs" USING btree ("lane","priority","run_at") WHERE "jobs"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "ix_jobs_lease" ON "jobs" USING btree ("lane","lease_until") WHERE "jobs"."state" = 'active';--> statement-breakpoint
CREATE INDEX "ix_jobs_finished" ON "jobs" USING btree ("finished_at") WHERE "jobs"."state" in ('completed', 'discarded');--> statement-breakpoint
CREATE INDEX "ix_outbox_events_subject" ON "outbox_events" USING btree ("company_id","subject_type","subject_id");