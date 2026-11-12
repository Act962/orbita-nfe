CREATE TABLE "service_invoice_cancellations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"client_application_id" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"lease_until" timestamp with time zone,
	"signed_xml" text,
	"signed_sha256" char(64),
	"layout_package" text,
	"sending_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lookups" integer DEFAULT 0 NOT NULL,
	"first_not_found_at" timestamp with time zone,
	"consecutive_lookup_errors" integer DEFAULT 0 NOT NULL,
	"outcome_code" text,
	"rejection_message" text,
	"event_xml" text,
	"registered_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_service_invoice_cancellations_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "ck_service_invoice_cancellations_state" CHECK ("service_invoice_cancellations"."state" in ('PENDING', 'PROCESSING', 'REGISTERED', 'REJECTED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "ck_service_invoice_cancellations_reason_code" CHECK ("service_invoice_cancellations"."reason_code" in ('1', '2', '9')),
	CONSTRAINT "ck_service_invoice_cancellations_reason_text" CHECK (char_length("service_invoice_cancellations"."reason_text") between 15 and 255),
	CONSTRAINT "ck_service_invoice_cancellations_signed" CHECK (("service_invoice_cancellations"."signed_xml" is null) = ("service_invoice_cancellations"."signed_sha256" is null)),
	CONSTRAINT "ck_service_invoice_cancellations_registered" CHECK ("service_invoice_cancellations"."state" <> 'REGISTERED' or "service_invoice_cancellations"."registered_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "service_invoices" DROP CONSTRAINT "ck_service_invoices_status";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_service_invoice_cancellations_active" ON "service_invoice_cancellations" USING btree ("invoice_id") WHERE "service_invoice_cancellations"."state" not in ('REJECTED', 'FAILED');--> statement-breakpoint
CREATE INDEX "ix_service_invoice_cancellations_company" ON "service_invoice_cancellations" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "service_invoices" ADD CONSTRAINT "ck_service_invoices_status" CHECK ("service_invoices"."status" in ('PENDING', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED', 'UNKNOWN', 'CANCELLED'));