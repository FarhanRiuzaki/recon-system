-- A simulation's changes are space data like the runs (0009 standard policy, every command).
select recon_enable_space_rls('recon_sim_changes');
--> statement-breakpoint
-- recon_analyze_month_partitions(parent, lo, hi, added) refreshes the planner statistics of `<parent>_YYYY_MM` for each
-- month of lo..hi whose rows changed since its last analyze (pg_stat_all_tables.n_mod_since_analyze, plus `added`: rows
-- the caller's own transaction just wrote, which count there only after its commit) are at least 1,000 and more than a
-- tenth of what its statistics count: autovacuum's analyze rule (scale factor 0.1), applied now instead of after a
-- commit and a nap. The engine calls it on records before a step's intake and on recon_items after each side's intake
-- (docs/recon/spikes.md "Plan 3 engine": planned over a fresh partition's statistics, the intake's anti join and the
-- passes turn into nested loops; 20,000 items a side ran past 30 s). ANALYZE needs the table's owner, so this runs as
-- the owner (security definer), on a domain table of that owner only, like recon_ensure_month_partitions (0009).
-- Answers how many partitions it analyzed. EXECUTE is the owner's and, through db:migrate (migrateJobs), APP_DB_ROLE's.
create function recon_analyze_month_partitions(parent regclass, lo date, hi date, added int) returns int
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  rel record;
  m date;
  part regclass;
  n int := 0;
  mods float8;
begin
  select c.relname, n2.nspname into rel
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n2 on n2.oid = c.relnamespace
    join pg_catalog.pg_partitioned_table p on p.partrelid = c.oid
    join pg_catalog.pg_attribute k on k.attrelid = c.oid and k.attnum = p.partattrs[0]
    where c.oid = parent and p.partstrat = 'r' and p.partnatts = 1
      and k.attname = 'business_date' and k.atttypid = 'pg_catalog.date'::pg_catalog.regtype
      and c.relowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
      and exists (select from pg_catalog.pg_attribute s where s.attrelid = c.oid and s.attname = 'space_id' and s.attnum > 0 and not s.attisdropped);
  if not found then
    raise exception 'recon_analyze_month_partitions: % is not a domain table of its owner partitioned by range of business_date (date) with space_id', parent;
  end if;
  if added is null or added < 0 or hi < lo or hi - lo > 400 then
    raise exception 'recon_analyze_month_partitions: a date range forwards of 400 days at most and added >= 0, got % .. %, %', lo, hi, added;
  end if;
  m := pg_catalog.date_trunc('month', lo)::date;
  while m <= hi loop
    part := pg_catalog.to_regclass(pg_catalog.format('%I.%I', rel.nspname, rel.relname || '_' || pg_catalog.to_char(m, 'YYYY_MM')));
    mods := coalesce((select s.n_mod_since_analyze from pg_catalog.pg_stat_all_tables s where s.relid = part), 0) + added;
    if part is not null and mods >= 1000 and mods > 0.1 * greatest((select c.reltuples from pg_catalog.pg_class c where c.oid = part), 0) then
      execute pg_catalog.format('analyze %s', part);
      n := n + 1;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return n;
end
$$;
--> statement-breakpoint
revoke execute on function recon_analyze_month_partitions(regclass, date, date, int) from public;
