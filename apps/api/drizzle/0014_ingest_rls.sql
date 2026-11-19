-- Row level security for the ingest tables (0009: the standard space policy, every command), plus read-only sharing
-- (DEC-042, as 0011 does for sources and source_versions): a space a source is shared to reads the data a recon of it
-- needs, and nothing else. Each extra policy is permissive and FOR SELECT only, so writes keep the standard policy
-- alone; boundaries.test.ts allowlists each with its reason.
--   records, raw_rows: the data a recon in the shared space matches on.
--   source_cursors, source_snapshots, source_files: completeness and health (complete_through, the active snapshot or
--     ingested file of a date), which a recon's grace and the shared space's Space map read.
--   quarantine_rows: none. Rejected lines are the owner's to fix (a corrected file or a new source version).
-- raw_rows and records are partitioned: reads and writes go through the parent, whose policies apply; each partition
-- gets the standard policy when recon_ensure_month_partitions makes it.
select recon_enable_space_rls('source_files');
--> statement-breakpoint
select recon_enable_space_rls('source_cursors');
--> statement-breakpoint
select recon_enable_space_rls('source_snapshots');
--> statement-breakpoint
select recon_enable_space_rls('raw_rows');
--> statement-breakpoint
select recon_enable_space_rls('records');
--> statement-breakpoint
select recon_enable_space_rls('quarantine_rows');
--> statement-breakpoint
create policy records_shared on records for select using (exists (
  select from source_shares s where s.space_id = records.space_id and s.source_id = records.source_id and recon_space_visible(s.to_space_id)));
--> statement-breakpoint
create policy raw_rows_shared on raw_rows for select using (exists (
  select from source_shares s where s.space_id = raw_rows.space_id and s.source_id = raw_rows.source_id and recon_space_visible(s.to_space_id)));
--> statement-breakpoint
create policy source_cursors_shared on source_cursors for select using (exists (
  select from source_shares s where s.space_id = source_cursors.space_id and s.source_id = source_cursors.source_id and recon_space_visible(s.to_space_id)));
--> statement-breakpoint
create policy source_snapshots_shared on source_snapshots for select using (exists (
  select from source_shares s where s.space_id = source_snapshots.space_id and s.source_id = source_snapshots.source_id and recon_space_visible(s.to_space_id)));
--> statement-breakpoint
create policy source_files_shared on source_files for select using (exists (
  select from source_shares s where s.space_id = source_files.space_id and s.source_id = source_files.source_id and recon_space_visible(s.to_space_id)));
