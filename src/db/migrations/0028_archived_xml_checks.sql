CREATE TABLE "archived_xml_checks" (
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "pk_archived_xml_checks" PRIMARY KEY("company_id","kind","document_id"),
	CONSTRAINT "ck_archived_xml_checks_kind" CHECK ("archived_xml_checks"."kind" in ('NFSE', 'CANCELLATION_EVENT')),
	CONSTRAINT "ck_archived_xml_checks_failure" CHECK ("archived_xml_checks"."failure_code" is null or "archived_xml_checks"."last_failed_at" is not null)
);
