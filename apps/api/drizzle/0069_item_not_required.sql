-- A one-way recon's side-B item without a counterpart (DEC-055): status not_required. Columns unqualified: the month
-- partitions take the constraint and the index too, and a table-qualified column fails there.
ALTER TABLE "recon_items" DROP CONSTRAINT "recon_items_status_check";--> statement-breakpoint
CREATE INDEX "recon_items_not_required" ON "recon_items" USING btree ("space_id","config_id","sim_run_id","side","business_date") WHERE status = 'not_required';--> statement-breakpoint
ALTER TABLE "recon_items" ADD CONSTRAINT "recon_items_status_check" CHECK (status in ('open', 'matched', 'suggested', 'break', 'closed', 'not_required'));
