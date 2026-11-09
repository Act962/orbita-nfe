CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"root_cnpj" varchar(8) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_companies_root_cnpj" UNIQUE("root_cnpj"),
	CONSTRAINT "ck_companies_status" CHECK ("companies"."status" in ('ACTIVE', 'SUSPENDED')),
	CONSTRAINT "ck_companies_root_cnpj" CHECK ("companies"."root_cnpj" ~ '^[0-9A-Z]{8}$')
);
--> statement-breakpoint
CREATE TABLE "establishments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"cnpj" varchar(14) NOT NULL,
	"trade_name" text NOT NULL,
	"municipality_code" char(7) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_establishments_cnpj" UNIQUE("cnpj"),
	CONSTRAINT "uq_establishments_company_id" UNIQUE("company_id","id"),
	CONSTRAINT "ck_establishments_status" CHECK ("establishments"."status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "ck_establishments_cnpj" CHECK ("establishments"."cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$'),
	CONSTRAINT "ck_establishments_municipality" CHECK ("establishments"."municipality_code" ~ '^[0-9]{7}$')
);
--> statement-breakpoint
CREATE TABLE "client_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_client_applications_name" UNIQUE("name"),
	CONSTRAINT "ck_client_applications_status" CHECK ("client_applications"."status" in ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "company_grants" (
	"company_id" uuid NOT NULL,
	"client_application_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_company_grants" PRIMARY KEY("company_id","client_application_id"),
	CONSTRAINT "ck_company_grants_status" CHECK ("company_grants"."status" in ('ACTIVE', 'REVOKED'))
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_application_id" uuid NOT NULL,
	"key_id" varchar(16) NOT NULL,
	"secret_hash" "bytea" NOT NULL,
	"environment" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "uq_credentials_key_id" UNIQUE("key_id"),
	CONSTRAINT "ck_credentials_key_id" CHECK ("credentials"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "ck_credentials_secret_hash" CHECK (octet_length("credentials"."secret_hash") = 32),
	CONSTRAINT "ck_credentials_environment" CHECK ("credentials"."environment" in ('live', 'test')),
	CONSTRAINT "ck_credentials_scopes" CHECK (cardinality("credentials"."scopes") > 0),
	CONSTRAINT "ck_credentials_status" CHECK ("credentials"."status" in ('ACTIVE', 'REVOKED')),
	CONSTRAINT "ck_credentials_revoked_at" CHECK (("credentials"."status" = 'REVOKED') = ("credentials"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "document_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"environment" text NOT NULL,
	"series" varchar(5) NOT NULL,
	"next_number" bigint NOT NULL,
	"max_number" bigint NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_document_series_key" UNIQUE("establishment_id","kind","environment","series"),
	CONSTRAINT "ck_document_series_kind" CHECK ("document_series"."kind" in ('NFSE_DPS', 'NFE', 'NFCE')),
	CONSTRAINT "ck_document_series_environment" CHECK ("document_series"."environment" in ('PRODUCTION', 'HOMOLOGATION')),
	CONSTRAINT "ck_document_series_series" CHECK ("document_series"."series" ~ '^(0|[1-9][0-9]{0,4})$'),
	CONSTRAINT "ck_document_series_status" CHECK ("document_series"."status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "ck_document_series_numbers" CHECK ("document_series"."max_number" between 1 and 999999999999999 and "document_series"."next_number" between 1 and "document_series"."max_number" + 1)
);
--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "fk_establishments_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_grants" ADD CONSTRAINT "fk_company_grants_client_application" FOREIGN KEY ("client_application_id") REFERENCES "public"."client_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "fk_credentials_client_application" FOREIGN KEY ("client_application_id") REFERENCES "public"."client_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_establishments_company" ON "establishments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ix_company_grants_client_application" ON "company_grants" USING btree ("client_application_id");--> statement-breakpoint
CREATE INDEX "ix_credentials_client_application" ON "credentials" USING btree ("client_application_id");--> statement-breakpoint
CREATE INDEX "ix_document_series_company" ON "document_series" USING btree ("company_id");