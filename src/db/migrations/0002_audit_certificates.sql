CREATE TABLE "audit_chain_heads" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_audit_chain_heads_hash" CHECK (octet_length("audit_chain_heads"."last_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_ref" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"correlation_id" text,
	"details" jsonb NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "uq_audit_log_sequence" UNIQUE("company_id","sequence"),
	CONSTRAINT "ck_audit_log_sequence" CHECK ("audit_log"."sequence" >= 1),
	CONSTRAINT "ck_audit_log_hashes" CHECK (octet_length("audit_log"."prev_hash") = 32 and octet_length("audit_log"."hash") = 32),
	CONSTRAINT "ck_audit_log_actor_kind" CHECK ("audit_log"."actor_kind" in ('CLIENT_APPLICATION', 'OPERATOR', 'SYSTEM'))
);
--> statement-breakpoint
CREATE TABLE "platform_audit_head" (
	"id" integer NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_hash" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_platform_audit_head" PRIMARY KEY("id"),
	CONSTRAINT "ck_platform_audit_head_single" CHECK ("platform_audit_head"."id" = 1),
	CONSTRAINT "ck_platform_audit_head_hash" CHECK (octet_length("platform_audit_head"."last_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_ref" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"correlation_id" text,
	"details" jsonb NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "uq_platform_audit_log_sequence" UNIQUE("sequence"),
	CONSTRAINT "ck_platform_audit_log_sequence" CHECK ("platform_audit_log"."sequence" >= 1),
	CONSTRAINT "ck_platform_audit_log_hashes" CHECK (octet_length("platform_audit_log"."prev_hash") = 32 and octet_length("platform_audit_log"."hash") = 32),
	CONSTRAINT "ck_platform_audit_log_actor_kind" CHECK ("platform_audit_log"."actor_kind" in ('OPERATOR', 'SYSTEM'))
);
--> statement-breakpoint
CREATE TABLE "certificates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"establishment_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING_VALIDATION' NOT NULL,
	"rejection_reason" text,
	"subject_cnpj" varchar(14),
	"subject_name" text,
	"issuer_name" text,
	"serial_number" text,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"thumbprint_sha256" varchar(64),
	"envelope_version" integer NOT NULL,
	"kek_id" varchar(16) NOT NULL,
	"wrapped_dek" "bytea",
	"pfx_sealed" "bytea" NOT NULL,
	"password_sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_certificates_status" CHECK ("certificates"."status" in ('PENDING_VALIDATION', 'ACTIVE', 'REJECTED', 'REPLACED', 'REVOKED')),
	CONSTRAINT "ck_certificates_rejection" CHECK (("certificates"."status" = 'REJECTED') = ("certificates"."rejection_reason" is not null)),
	CONSTRAINT "ck_certificates_revoked" CHECK (("certificates"."status" = 'REVOKED') = ("certificates"."revoked_at" is not null) and ("certificates"."status" <> 'REVOKED' or "certificates"."wrapped_dek" is null)),
	CONSTRAINT "ck_certificates_envelope" CHECK ("certificates"."status" = 'REVOKED' or "certificates"."wrapped_dek" is not null),
	CONSTRAINT "ck_certificates_metadata" CHECK ("certificates"."status" not in ('ACTIVE', 'REPLACED') or ("certificates"."thumbprint_sha256" is not null and "certificates"."not_after" is not null and "certificates"."subject_cnpj" is not null)),
	CONSTRAINT "ck_certificates_thumbprint" CHECK ("certificates"."thumbprint_sha256" is null or "certificates"."thumbprint_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_certificates_kek_id" CHECK ("certificates"."kek_id" ~ '^[0-9a-f]{16}$')
);
--> statement-breakpoint
CREATE INDEX "ix_audit_log_subject" ON "audit_log" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_certificates_active" ON "certificates" USING btree ("establishment_id") WHERE "certificates"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "ix_certificates_establishment" ON "certificates" USING btree ("company_id","establishment_id");--> statement-breakpoint
CREATE INDEX "ix_certificates_expiry" ON "certificates" USING btree ("not_after") WHERE "certificates"."status" = 'ACTIVE';