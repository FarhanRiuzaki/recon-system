ALTER TABLE "recon_items" ADD COLUMN "proposed_item_id" uuid;--> statement-breakpoint
ALTER TABLE "recon_items" ADD COLUMN "proposed_pass" smallint;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "seen" jsonb;--> statement-breakpoint
-- The health inputs of published configs again (0030's backfill saw no row under FORCE ROW LEVEL SECURITY unless run
-- as a superuser), now scoped to every space, with the deadline rule of approve: a daily config whose date offset is
-- at least one day (its run time is when the date's data must be there), else none.
select set_config('app.space_ids', coalesce((select string_agg(id::text, ',') from spaces), ''), true);
--> statement-breakpoint
update recon_source_uses u set
  grace_minutes = nullif((v.spec ->> 'grace_minutes')::int, 0),
  deadline = case when v.spec -> 'schedule' ->> 'kind' = 'daily' and (v.spec -> 'schedule' ->> 'business_date_offset')::int >= 1
    then v.spec -> 'schedule' ->> 'at' end
from recon_config_versions v
where v.space_id = u.space_id and v.config_id = u.config_id and v.status = 'published';
