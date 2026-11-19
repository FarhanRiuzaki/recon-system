-- Row level security for space-owned tables (recon spec §11). Every domain table (Plan 2+) enables and forces RLS with
--   create policy <t>_space on <t> using (recon_space_visible(space_id)) with check (recon_space_visible(space_id));
-- withSpace (modules/spaces/service.ts) sets app.space_ids (comma-separated UUIDs) local to its transaction.
-- Fails closed: NULL (a connection that never set it) and '' (a pooled connection after an earlier SET LOCAL ended) are
-- false. It reads only the setting, never another table: a sub-select in a policy can leak under concurrency (§11).
create function recon_space_visible(space_id uuid) returns boolean language sql stable as $$
  select coalesce(space_id = any (string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]), false)
$$;
