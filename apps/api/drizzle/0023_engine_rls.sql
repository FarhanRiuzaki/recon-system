-- Row level security for the engine tables (0009: the standard space policy, every command), no extra policy: a run
-- reads a source shared to its space through the records policies (0014, DEC-042) and writes only its own space's rows.
-- recon_items is partitioned: reads and writes go through the parent, whose policy applies; each partition gets the
-- standard policy when recon_ensure_month_partitions makes it.
select recon_enable_space_rls('recon_runs');
--> statement-breakpoint
select recon_enable_space_rls('recon_items');
--> statement-breakpoint
select recon_enable_space_rls('match_groups');
--> statement-breakpoint
select recon_enable_space_rls('match_members');
