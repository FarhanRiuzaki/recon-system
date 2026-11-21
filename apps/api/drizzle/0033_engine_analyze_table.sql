-- recon_analyze_table(tbl, added) refreshes the planner statistics of a plain (not partitioned) domain table of the
-- owner, with a space_id column, when its rows changed since its last analyze (pg_stat_all_tables.n_mod_since_analyze
-- plus `added`, rows the caller just wrote) are at least 1,000 and more than a tenth of what its statistics count:
-- autovacuum's rule, applied now. The engine calls it on match_groups and match_members when a run ends, so the result
-- screens' reads right after it are planned over the groups it wrote (with an empty table's statistics the items page
-- joined every item with every group: past the API's 5 s timeout at 5,000 items a side). Security definer: ANALYZE
-- needs the owner. Answers whether it analyzed. EXECUTE is the owner's and, through db:migrate (migrateJobs), APP_DB_ROLE's.
create function recon_analyze_table(tbl regclass, added int) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  mods float8;
begin
  if not exists (select from pg_catalog.pg_class c
      where c.oid = tbl and c.relkind = 'r'
        and c.relowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
        and exists (select from pg_catalog.pg_attribute s where s.attrelid = c.oid and s.attname = 'space_id' and s.attnum > 0 and not s.attisdropped)) then
    raise exception 'recon_analyze_table: % is not a plain domain table of its owner with space_id', tbl;
  end if;
  if added is null or added < 0 or added > 1000000000 then
    raise exception 'recon_analyze_table: added 0 to 1e9, got %', added;
  end if;
  mods := coalesce((select s.n_mod_since_analyze from pg_catalog.pg_stat_all_tables s where s.relid = tbl), 0) + added;
  if mods < 1000 or mods <= 0.1 * greatest((select c.reltuples from pg_catalog.pg_class c where c.oid = tbl), 0) then
    return false;
  end if;
  execute pg_catalog.format('analyze %s', tbl);
  return true;
end
$$;
--> statement-breakpoint
revoke execute on function recon_analyze_table(regclass, int) from public;
