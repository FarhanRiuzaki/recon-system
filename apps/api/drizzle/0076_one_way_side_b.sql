-- A one-way recon's side B never breaks (DEC-062, owner 26 Nov: "di side B akan pasti not required, ga akan jadi
-- unmatch side B, kecuali two way"). The side-B breaks a one-way recon already holds (a near miss, a double settlement,
-- a Duplicate, an unconfirmed suggestion) become not required, as the engine now makes them, when nobody works on
-- them: no queue state or assignee, no resolution, not in a posting group, their date not signed off. A closed date's
-- stored open counter drops by the items it loses. Every space is in scope: the tables force row level security.
select set_config('app.space_ids', coalesce((select string_agg(id::text, ',') from spaces), ''), true);
--> statement-breakpoint
with one_way as (select v.space_id, v.config_id from recon_config_versions v where v.status = 'published' and v.spec ->> 'direction' = 'a_to_b'),
nr as (update recon_items i set status = 'not_required', break_reason = null, late_match = false, proposed_item_id = null, proposed_pass = null,
    version = i.version + 1
  from one_way o
  where i.space_id = o.space_id and i.config_id = o.config_id and i.sim_run_id is null and i.side = 'b' and i.status = 'break'
    and i.break_state is null and i.assignee_id is null and i.resolution is null
    and not exists (select 1 from posting_group_items pg where pg.item_id = i.id)
    and not exists (select 1 from recon_days d where d.space_id = i.space_id and d.config_id = i.config_id and d.business_date = i.business_date
      and d.signed_at is not null)
  returning i.space_id, i.config_id, i.business_date),
n as (select space_id, config_id, business_date, count(*)::int as n from nr group by 1, 2, 3)
update recon_days d set counters = jsonb_set(coalesce(d.counters, '{}'::jsonb), '{open}', to_jsonb(greatest(coalesce((d.counters ->> 'open')::int, 0) - n.n, 0)))
from n where d.space_id = n.space_id and d.config_id = n.config_id and d.business_date = n.business_date and d.status = 'closed';
