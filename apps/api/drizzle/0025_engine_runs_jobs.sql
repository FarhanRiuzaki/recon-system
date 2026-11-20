CREATE TABLE "recon_sim_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"change" text NOT NULL,
	"draft_group_id" uuid,
	"published_group_id" uuid,
	"business_date" date NOT NULL,
	CONSTRAINT "recon_sim_changes_change_check" CHECK ("recon_sim_changes"."change" in ('gained', 'lost', 'repaired', 'kind'))
);
--> statement-breakpoint
ALTER TABLE "recon_runs" DROP CONSTRAINT "recon_runs_status_check";--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "spec_hash" text;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "done_through" date;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "baseline_of" uuid;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "recon_sim_changes" ADD CONSTRAINT "recon_sim_changes_run_fkey" FOREIGN KEY ("space_id","run_id") REFERENCES "recon_runs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recon_sim_changes_run" ON "recon_sim_changes" USING btree ("space_id","run_id","change","business_date");--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_baseline_fkey" FOREIGN KEY ("space_id","baseline_of") REFERENCES "recon_runs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_status_check" CHECK ("recon_runs"."status" in ('queued', 'running', 'succeeded', 'failed'));