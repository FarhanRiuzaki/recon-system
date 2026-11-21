ALTER TABLE "recon_runs" ADD COLUMN "finalize_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "finalize_error" text;