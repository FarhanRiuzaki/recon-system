-- Domain tables of Plan 2+ (recon spec §8, §11): the space policy in one call, and monthly partitions by business_date.
-- Both functions pin search_path to pg_catalog, pg_temp (pg_temp last, so a caller's temp table can't stand in for a
-- catalog) and name every catalog table with pg_catalog. and their own functions with the table's schema.

-- RLS for a space-owned table: enable, force (the owner too) and the one policy recon_space_visible(space_id) for USING
-- and WITH CHECK (0007). A migration calls it after creating the table: select recon_enable_space_rls('sources');
-- boundaries.test.ts fails for any table with a space_id column that lacks exactly this. The policy's function is the
-- one in the table's schema.
create function recon_enable_space_rls(t regclass) returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  rel record;
begin
  select c.relname, n.nspname into strict rel from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.oid = t;
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy %I on %s using (%I.recon_space_visible(space_id)) with check (%I.recon_space_visible(space_id))',
    rel.relname || '_space', t, rel.nspname, rel.nspname);
end
$$;

-- Monthly partitions of a table partitioned by range of business_date. drizzle-kit can't declare a partitioned table:
-- schema.ts declares the parent as a plain table (its primary and unique keys include business_date), db:generate
-- writes its CREATE TABLE, and before that file is ever applied `partition by range (business_date)` is added to it
-- by hand; the snapshot in meta/ stays as drizzle-kit wrote it, so schema-drift.test.ts still sees no change.
--
-- recon_ensure_month_partitions(parent, first_month, months) creates `<parent>_YYYY_MM` for each of `months` months from
-- the month of `first_month` that has none yet, each with the space policy. Only the owner of a table may add a
-- partition to it, and the app role owns none (it has DML only, AGENTS.md §3), so this runs as its owner (security
-- definer). It acts only on a domain table of that owner: range-partitioned on the one column business_date of type
-- date, with a space_id column; anything else raises. Call it through ensureMonthPartitions (kernel/partitions.ts),
-- which takes the `partitions` advisory lock first, so two callers never race on one month. EXECUTE is the owner's and,
-- through db:migrate (migrateJobs), APP_DB_ROLE's only.
create function recon_ensure_month_partitions(parent regclass, first_month date, months int) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  rel record;
  m date;
  part text;
begin
  if months is null or months < 1 or months > 24 then
    raise exception 'recon_ensure_month_partitions: months must be 1 to 24, got %', months;
  end if;
  select c.relname, n.nspname into rel
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_partitioned_table p on p.partrelid = c.oid
    join pg_catalog.pg_attribute k on k.attrelid = c.oid and k.attnum = p.partattrs[0]
    where c.oid = parent and p.partstrat = 'r' and p.partnatts = 1
      and k.attname = 'business_date' and k.atttypid = 'pg_catalog.date'::pg_catalog.regtype
      and c.relowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
      and exists (select from pg_catalog.pg_attribute s where s.attrelid = c.oid and s.attname = 'space_id' and s.attnum > 0 and not s.attisdropped);
  if not found then
    raise exception 'recon_ensure_month_partitions: % is not a domain table of its owner partitioned by range of business_date (date) with space_id', parent;
  end if;
  for i in 0 .. months - 1 loop
    m := (pg_catalog.date_trunc('month', first_month) + pg_catalog.make_interval(months => i))::date;
    part := rel.relname || '_' || pg_catalog.to_char(m, 'YYYY_MM');
    if pg_catalog.to_regclass(pg_catalog.format('%I.%I', rel.nspname, part)) is null then
      execute pg_catalog.format('create table if not exists %I.%I partition of %s for values from (%L) to (%L)',
        rel.nspname, part, parent, m, (m + interval '1 month')::date);
      execute pg_catalog.format('select %I.recon_enable_space_rls(%L::pg_catalog.regclass)', rel.nspname, pg_catalog.format('%I.%I', rel.nspname, part));
    end if;
  end loop;
end
$$;

revoke execute on function recon_enable_space_rls(regclass) from public;
revoke execute on function recon_ensure_month_partitions(regclass, date, int) from public;
