CREATE TABLE "certificate_expiry_notices" (
	"company_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"threshold_days" integer NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_certificate_expiry_notices" PRIMARY KEY("certificate_id","threshold_days"),
	CONSTRAINT "ck_certificate_expiry_notices_threshold" CHECK ("certificate_expiry_notices"."threshold_days" in (30, 15, 7, 1, 0))
);
--> statement-breakpoint
CREATE INDEX "ix_certificate_expiry_notices_company" ON "certificate_expiry_notices" USING btree ("company_id");