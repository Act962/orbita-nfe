CREATE TABLE "production_enablements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "ck_production_enablements_kind" CHECK ("production_enablements"."kind" in ('NFSE_DPS', 'NFE', 'NFCE')),
	CONSTRAINT "ck_production_enablements_status" CHECK ("production_enablements"."status" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "ck_production_enablements_revocation" CHECK (("production_enablements"."status" = 'ACTIVE' and "production_enablements"."revoked_at" is null and "production_enablements"."revocation_reason" is null) or ("production_enablements"."status" = 'REVOKED' and "production_enablements"."revoked_at" is not null and length("production_enablements"."revocation_reason") between 1 and 300))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_production_enablements_active" ON "production_enablements" USING btree ("establishment_id","kind") WHERE "production_enablements"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "ix_production_enablements_company" ON "production_enablements" USING btree ("company_id");