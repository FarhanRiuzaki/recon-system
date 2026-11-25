-- Rolling back a watermark pull (owner, 25 Nov: a source's mapping changed and the rows pulled again were stored a
-- second time under their new business date): each pull keeps the cursor it started from (started_from) and when a
-- rollback removed what it wrote (rolled_back_at); a source keeps the rollback asked for until its next pull does it
-- (source_cursors.rollback_from). Every space is in scope: the tables force row level security (as 0066).
ALTER TABLE "source_cursors" ADD COLUMN "rollback_from" uuid;--> statement-breakpoint
ALTER TABLE "source_pulls" ADD COLUMN "started_from" jsonb;--> statement-breakpoint
ALTER TABLE "source_pulls" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
select set_config('app.space_ids', coalesce((select string_agg(id::text, ',') from spaces), ''), true);
--> statement-breakpoint
-- A pull before this release kept an id of its own and wrote its rows under another (the run's origin_id). Pair them,
-- newest first per source: the n-th newest pull that added records with the n-th newest run of records, when the
-- records it added are exactly that run's. A pull left unpaired keeps its id (and stays not known below).
with runs as (
  select r.space_id, r.source_id, r.origin_id, count(*) as n,
    row_number() over (partition by r.space_id, r.source_id order by min(r.seq) desc) as k
  from records r join sources s on s.space_id = r.space_id and s.id = r.source_id and s.kind = 'db_watermark'
  group by r.space_id, r.source_id, r.origin_id),
pulls as (
  select id, space_id, source_id, added, row_number() over (partition by space_id, source_id order by started_at desc, id desc) as k
  from source_pulls where added > 0),
pair as (select p.id, r.origin_id from pulls p join runs r on r.space_id = p.space_id and r.source_id = p.source_id and r.k = p.k and r.n = p.added)
update source_pulls p set id = pair.origin_id from pair where p.id = pair.id;
--> statement-breakpoint
-- Where a pull before this release started is known only when nothing came before it: no earlier pull reached a
-- watermark, and every pulled record of the source belongs to a pull still listed (none older, purged after 30 days,
-- nor one left unpaired above). Those started from the beginning ({}); the others stay null, and can't be rolled back.
update source_pulls p set started_from = '{}'::jsonb
where not exists (select 1 from source_pulls e where e.space_id = p.space_id and e.source_id = p.source_id
    and (e.started_at, e.id) < (p.started_at, p.id) and e.watermark is not null)
  and not exists (select 1 from records r where r.space_id = p.space_id and r.source_id = p.source_id
    and not exists (select 1 from source_pulls x where x.space_id = r.space_id and x.source_id = r.source_id and x.id = r.origin_id));
