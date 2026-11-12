CREATE TABLE "service_invoice_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_sha256" char(64) NOT NULL,
	"nfse_xml" text,
	"operator" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"result_code" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "ck_service_invoice_resolutions_outcome" CHECK ("service_invoice_resolutions"."outcome" in ('AUTHORIZED', 'NOT_ISSUED')),
	CONSTRAINT "ck_service_invoice_resolutions_state" CHECK ("service_invoice_resolutions"."state" in ('REQUESTED', 'APPLIED', 'REFUSED')),
	CONSTRAINT "ck_service_invoice_resolutions_reason" CHECK (length(btrim("service_invoice_resolutions"."reason")) between 10 and 2000),
	CONSTRAINT "ck_service_invoice_resolutions_operator" CHECK (length("service_invoice_resolutions"."operator") between 1 and 200),
	CONSTRAINT "ck_service_invoice_resolutions_evidence" CHECK ("service_invoice_resolutions"."evidence_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_service_invoice_resolutions_xml" CHECK (("service_invoice_resolutions"."outcome" = 'AUTHORIZED') = ("service_invoice_resolutions"."nfse_xml" is not null)),
	CONSTRAINT "ck_service_invoice_resolutions_decided" CHECK (("service_invoice_resolutions"."state" = 'REQUESTED') = ("service_invoice_resolutions"."decided_at" is null)),
	CONSTRAINT "ck_service_invoice_resolutions_result" CHECK ("service_invoice_resolutions"."state" <> 'REFUSED' or "service_invoice_resolutions"."result_code" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_service_invoice_resolutions_open" ON "service_invoice_resolutions" USING btree ("invoice_id") WHERE "service_invoice_resolutions"."state" = 'REQUESTED';--> statement-breakpoint
CREATE INDEX "ix_service_invoice_resolutions_company" ON "service_invoice_resolutions" USING btree ("company_id");