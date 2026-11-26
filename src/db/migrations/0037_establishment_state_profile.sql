ALTER TABLE "establishments" ADD COLUMN "state_registration" varchar(14);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "tax_regime" char(1);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_street" varchar(60);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_number" varchar(60);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_complement" varchar(60);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_district" varchar(60);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_postal_code" char(8);--> statement-breakpoint
ALTER TABLE "establishments" ADD COLUMN "address_phone" varchar(14);--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "ck_establishments_state_profile_complete" CHECK (("establishments"."state_registration" is null) = ("establishments"."tax_regime" is null) and ("establishments"."state_registration" is null) = ("establishments"."address_street" is null)
        and ("establishments"."state_registration" is null) = ("establishments"."address_number" is null) and ("establishments"."state_registration" is null) = ("establishments"."address_district" is null)
        and ("establishments"."state_registration" is null) = ("establishments"."address_postal_code" is null)
        and ("establishments"."state_registration" is not null or ("establishments"."address_complement" is null and "establishments"."address_phone" is null)));--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "ck_establishments_state_registration" CHECK ("establishments"."state_registration" is null or "establishments"."state_registration" ~ '^([0-9]{2,14}|ISENTO)$');--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "ck_establishments_tax_regime" CHECK ("establishments"."tax_regime" is null or "establishments"."tax_regime" in ('1', '2', '3', '4'));--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "ck_establishments_postal_code" CHECK ("establishments"."address_postal_code" is null or "establishments"."address_postal_code" ~ '^[0-9]{8}$');--> statement-breakpoint
ALTER TABLE "establishments" ADD CONSTRAINT "ck_establishments_phone" CHECK ("establishments"."address_phone" is null or "establishments"."address_phone" ~ '^[0-9]{6,14}$');