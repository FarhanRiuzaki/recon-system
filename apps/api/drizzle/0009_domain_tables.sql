-- Domain tables of Plan 2+ (recon spec §8, §11): the space policy in one call, and monthly partitions by business_date.

-- RLS for a space-owned table: enable, force (the owner too) and the one policy recon_space_visible(space_id) for USING
-- and WITH CHECK (0007). A migration calls it after creating the table: select recon_enable_space_rls('sources');
-- boundaries.test.ts fails for any table with a space_id column that lacks exactly this.
create function recon_enable_space_rls(t regclass) returns void language plpgsql as $$
begin
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy %I on %s using (recon_space_visible(space_id)) with check (recon_space_visible(space_id))',
    (select relname from pg_class where oid = t) || '_space', t);
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
-- definer) and acts only on a range-partitioned table that owner owns. Call it through ensureMonthPartitions
-- (kernel/partitions.ts), which takes the `partitions` advisory lock first, so two callers never race on one month.
create function recon_ensure_month_partitions(parent regclass, first_month date, months int) returns void
language plpgsql security definer set search_path from current as $$
declare
  rel record;
  m date;
  part text;
begin
  if months is null or months < 1 or months > 24 then
    raise exception 'recon_ensure_month_partitions: months must be 1 to 24, got %', months;
  end if;
  select c.relname, n.nspname into rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_partitioned_table p on p.partrelid = c.oid
    where c.oid = parent and p.partstrat = 'r' and p.partnatts = 1 and c.relowner = (select oid from pg_roles where rolname = current_user);
  if not found then
    raise exception 'recon_ensure_month_partitions: % is not a range-partitioned table of its owner', parent;
  end if;
  for i in 0 .. months - 1 loop
    m := (date_trunc('month', first_month) + make_interval(months => i))::date;
    part := rel.relname || '_' || to_char(m, 'YYYY_MM');
    if to_regclass(format('%I.%I', rel.nspname, part)) is null then
      execute format('create table if not exists %I.%I partition of %s for values from (%L) to (%L)',
        rel.nspname, part, parent, m, (m + interval '1 month')::date);
      perform recon_enable_space_rls(format('%I.%I', rel.nspname, part)::regclass);
    end if;
  end loop;
end
$$;
