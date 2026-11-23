ALTER TABLE "service_invoices" ADD COLUMN "nfse_xml_sha256" char(64);--> statement-breakpoint
ALTER TABLE "service_invoices" ADD COLUMN "nfse_xml_object_key" text;--> statement-breakpoint
ALTER TABLE "service_invoices" ADD COLUMN "nfse_xml_archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_invoices" ADD COLUMN "nfse_xml_retain_until" timestamp with time zone;