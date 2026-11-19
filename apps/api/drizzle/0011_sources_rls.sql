-- Row level security for the source tables (0009: the standard space policy, every command), plus read-only sharing
-- (spec §11: a source is owned by one space and shared to others through source_shares, read-only). The extra
-- policies are permissive and FOR SELECT only, so they OR into reads and never into INSERT, UPDATE or DELETE, which
-- keep the standard policy alone; boundaries.test.ts allowlists exactly these three. calendars is global: no space_id,
-- no RLS.
select recon_enable_space_rls('sources');
--> statement-breakpoint
select recon_enable_space_rls('source_connections');
--> statement-breakpoint
select recon_enable_space_rls('source_versions');
--> statement-breakpoint
select recon_enable_space_rls('source_shares');
--> statement-breakpoint
-- The space a source is shared to sees its share row; the two policies below read it through this policy.
create policy source_shares_to on source_shares for select using (recon_space_visible(to_space_id));
--> statement-breakpoint
create policy sources_shared on sources for select using (exists (
  select from source_shares s where s.space_id = sources.space_id and s.source_id = sources.id and recon_space_visible(s.to_space_id)));
--> statement-breakpoint
-- Published and retired versions only: a draft or one in review stays with the owner space. No policy shares
-- source_connections: the credential never leaves its space.
create policy source_versions_shared on source_versions for select using (status in ('published', 'retired') and exists (
  select from source_shares s where s.space_id = source_versions.space_id and s.source_id = source_versions.source_id and recon_space_visible(s.to_space_id)));
