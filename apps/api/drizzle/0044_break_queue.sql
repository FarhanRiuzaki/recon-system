ALTER TABLE "recon_items" ADD COLUMN "break_state" text;--> statement-breakpoint
ALTER TABLE "recon_items" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "recon_items" ADD COLUMN "state_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "recon_items_break_queue" ON "recon_items" USING btree ("space_id","assignee_id","business_date") WHERE "recon_items"."status" = 'break' and "recon_items"."sim_run_id" is null;--> statement-breakpoint
ALTER TABLE "recon_items" ADD CONSTRAINT "recon_items_break_state_check" CHECK (break_state is null or break_state in ('assigned', 'investigating', 'pending_external', 'proposed_resolution', 'pending_approval', 'resolved'));