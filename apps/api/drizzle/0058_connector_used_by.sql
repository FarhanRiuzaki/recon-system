-- Audit §5.8, C2: a connector (global) says how many recons use it, and those recons live in every space. A connector
-- reader holds no space role, so row level security would hide them all; this answers only (connector_id, recons) for
-- `ids`: the recons of an active space whose published version has an approval action variant calling the connector.
-- No recon, space or spec leaves it. One pass over the published versions, each spec's connector ids read once (not
-- one jsonb scan per connector). Runs as the owner (security definer); its search_path is the schema it was made in.
-- EXECUTE is the owner's and, through db:migrate (migrateJobs), APP_DB_ROLE's.
create function recon_connector_used_by(ids uuid[]) returns table (connector_id uuid, recons int)
language sql stable security definer set search_path from current as $$
  select u.id::uuid, count(distinct v.config_id)::int
  from recon_config_versions v
  join spaces s on s.id = v.space_id and s.status = 'active'
  cross join lateral (select distinct x #>> '{}' as id
    from jsonb_path_query(v.spec, '$.approvals.changes.*.actions[*].variants[*].operation.connectorId') x) u
  where v.status = 'published' and u.id = any (ids::text[])
  group by u.id
$$;
--> statement-breakpoint
revoke execute on function recon_connector_used_by(uuid[]) from public;
