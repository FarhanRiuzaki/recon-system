ALTER TABLE "recon_runs" ADD COLUMN "intake_done" text;--> statement-breakpoint
CREATE INDEX "match_groups_sim_run" ON "match_groups" USING btree ("space_id","sim_run_id") WHERE "match_groups"."sim_run_id" is not null;--> statement-breakpoint
CREATE INDEX "recon_items_sim_run" ON "recon_items" USING btree ("space_id","sim_run_id") WHERE "recon_items"."sim_run_id" is not null;--> statement-breakpoint
CREATE INDEX "recon_runs_baseline" ON "recon_runs" USING btree ("space_id","baseline_of") WHERE "recon_runs"."baseline_of" is not null;