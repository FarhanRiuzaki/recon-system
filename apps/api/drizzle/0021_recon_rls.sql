-- Row level security for the recon tables (0009: the standard space policy, every command). A config of a space may
-- read a source another space shares to it (DEC-042, through the source tables' own policies); nothing here widens that.
-- recon_source_uses gets one permissive FOR SELECT policy: the space that owns a source reads which published configs
-- use which of its fields (and their names), so it can refuse a source version that drops or retypes one (Plan 3 A4),
-- also for a config of a space it shares the source to. Writes keep the standard policy alone; boundaries.test.ts
-- allowlists the extra policy with its reason.
select recon_enable_space_rls('recon_configs');
--> statement-breakpoint
select recon_enable_space_rls('recon_config_versions');
--> statement-breakpoint
select recon_enable_space_rls('recon_source_uses');
--> statement-breakpoint
create policy recon_source_uses_source_owner on recon_source_uses for select using (recon_space_visible(source_space_id));
