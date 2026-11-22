ALTER TABLE "recon_days" ADD COLUMN "prepared_by" uuid;--> statement-breakpoint
ALTER TABLE "recon_days" ADD COLUMN "prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recon_days" ADD COLUMN "signed_by" uuid;--> statement-breakpoint
ALTER TABLE "recon_days" ADD COLUMN "signed_at" timestamp with time zone;