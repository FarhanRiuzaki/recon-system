ALTER TABLE "recon_items" ADD COLUMN "break_run_id" uuid;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "rollback_of" uuid;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "rolled_back_by" uuid;--> statement-breakpoint
CREATE INDEX "recon_items_break_run" ON "recon_items" USING btree ("space_id","config_id","break_run_id") WHERE "recon_items"."break_run_id" is not null and "recon_items"."status" in ('break', 'not_required');