-- REC-FUT-16 (Captain, 21 Nov): a source's business date is closed when any config that reads the source, in any space
-- (a shared source's too), has closed that date. The ingest refuses to pull such a date again (a rerun with approval,
-- Plan 5). The source's own space can't see another space's recon_days under row level security, so this answers
-- only the boolean, as the owner (security definer); its search_path is the schema it was made in. EXECUTE is the
-- owner's and, through db:migrate (migrateJobs), APP_DB_ROLE's.
create function recon_source_day_closed(source_space uuid, source uuid, d date) returns boolean
language sql stable security definer set search_path from current as $$
  select exists (select 1 from recon_source_uses u
    join recon_days rd on rd.space_id = u.space_id and rd.config_id = u.config_id
    where u.source_space_id = source_space and u.source_id = source and rd.business_date = d and rd.status = 'closed')
$$;
--> statement-breakpoint
revoke execute on function recon_source_day_closed(uuid, uuid, date) from public;
