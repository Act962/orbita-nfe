CREATE TABLE "establishments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cnpj" varchar(14) NOT NULL,
	"trade_name" text NOT NULL,
	"municipality_code" char(7) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_establishments_cnpj" UNIQUE("cnpj"),
	CONSTRAINT "uq_establishments_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ck_establishments_status" CHECK ("establishments"."status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "ck_establishments_cnpj" CHECK ("establishments"."cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$'),
	CONSTRAINT "ck_establishments_municipality" CHECK ("establishments"."municipality_code" ~ '^[0-9]{7}$')
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"root_cnpj" varchar(8) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_tenants_root_cnpj" UNIQUE("root_cnpj"),
	CONSTRAINT "ck_tenants_status" CHECK ("tenants"."status" in ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "ck_tenants_root_cnpj" CHECK ("tenants"."root_cnpj" ~ '^[0-9A-Z]{8}$')
);
--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "fk_establishments_tenant" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_establishments_tenant" ON "establishments" USING btree ("tenant_id");