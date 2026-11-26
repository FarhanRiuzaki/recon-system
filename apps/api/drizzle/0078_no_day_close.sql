-- No day close (DEC-064, owner 26 Nov: "tanpa close … langsung saja unmatch. yang unmatch ini bisa di recon lagi selama
-- carry over"): one schedule shape (business_date_offset, from, to, every_minutes), no close_at or grace_minutes in a
-- recon spec, recon_days only the sign-off of a date, and a date frozen by its sign-off instead of its close. Every
-- space is in scope: the tables force row level security.
select set_config('app.space_ids', coalesce((select string_agg(id::text, ',') from spaces), ''), true);
--> statement-breakpoint
-- stored recon specs: daily at X, offset N → window X–X (one run), offset N; interval every N → today, all day, every N
update recon_config_versions set spec = (spec - 'close_at' - 'grace_minutes') || jsonb_build_object('schedule',
  case when spec #>> '{schedule,kind}' = 'daily'
    then jsonb_build_object('business_date_offset', (spec #>> '{schedule,business_date_offset}')::int, 'from', spec #>> '{schedule,at}',
      'to', spec #>> '{schedule,at}', 'every_minutes', 60)
    else jsonb_build_object('business_date_offset', 0, 'from', '00:00', 'to', '23:59', 'every_minutes', (spec #>> '{schedule,every_minutes}')::int)
  end)
where spec -> 'schedule' ? 'kind';
--> statement-breakpoint
-- a source's health no longer takes a recon's grace (the recon has none)
update recon_source_uses set grace_minutes = null where grace_minutes is not null;
--> statement-breakpoint
ALTER TABLE "recon_days" DROP CONSTRAINT "recon_days_status_check";--> statement-breakpoint
-- a closed or closing day nobody prepared is open again; a prepared or signed one keeps its sign-off
delete from recon_days where prepared_at is null;
--> statement-breakpoint
update recon_days set status = case when signed_at is not null then 'signed' else 'prepared' end;
--> statement-breakpoint
ALTER TABLE "recon_days" DROP COLUMN "incomplete";--> statement-breakpoint
ALTER TABLE "recon_days" DROP COLUMN "counters";--> statement-breakpoint
ALTER TABLE "recon_days" DROP COLUMN "closing_at";--> statement-breakpoint
ALTER TABLE "recon_days" DROP COLUMN "closed_at";--> statement-breakpoint
ALTER TABLE "recon_days" ADD CONSTRAINT "recon_days_status_check" CHECK ("recon_days"."status" in ('prepared', 'signed'));
--> statement-breakpoint
-- whether any space signed off a source's date (the name kept: its grants and the allowlist follow it), REC-FUT-16
create or replace function recon_source_day_closed(source_space uuid, source uuid, d date) returns boolean
language sql stable security definer set search_path from current as $$
  select exists (select 1 from recon_source_uses u
    join recon_days rd on rd.space_id = u.space_id and rd.config_id = u.config_id
    where u.source_space_id = source_space and u.source_id = source and rd.business_date = d and rd.signed_at is not null)
$$;
--> statement-breakpoint
-- a source's due inputs from the recons reading it (0068): the last scheduled run of a date, in minutes after its start
create or replace function recon_source_due(source_spaces uuid[], source_ids uuid[]) returns table (source_id uuid, grace_minutes int, deadline text, close_minutes int)
language sql stable security definer set search_path from current as $$
  select u.source_id, min(u.grace_minutes)::int, min(u.deadline), min(
    (v.spec #>> '{schedule,business_date_offset}')::int * 1440 + split_part(v.spec #>> '{schedule,to}', ':', 1)::int * 60 + split_part(v.spec #>> '{schedule,to}', ':', 2)::int
  )::int
  from unnest(source_spaces, source_ids) as x(space_id, id)
  join recon_source_uses u on u.source_space_id = x.space_id and u.source_id = x.id
  join spaces s on s.id = u.space_id and s.status = 'active'
  join recon_config_versions v on v.space_id = u.space_id and v.config_id = u.config_id and v.status = 'published'
  group by u.source_id
$$;
