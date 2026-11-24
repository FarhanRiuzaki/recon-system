-- When a source's business date was due, kept with its completion (ingest/schema.ts source_deliveries.due_at): the
-- rule in force then is the one judged later. Rows kept before this have none and are judged by today's rule.
ALTER TABLE "source_deliveries" ADD COLUMN "due_at" timestamp with time zone;
--> statement-breakpoint
-- What a source's dates are due on from the recons that read it, in every space (a shared source's too), whoever asks:
-- under row level security a space sees only its own recons, so the due time would change with the viewer. Answers
-- per source of the pairs (source_spaces[i], source_ids[i]) only aggregates over the published recons of active spaces
-- reading it: the smallest grace and earliest deadline of recon_source_uses (health's inputs), and the earliest close +
-- grace in minutes after the date's start (engine/rules.ts closeMoment: a daily recon at `at` on D + offset days, an
-- interval one at `close_at` on D). No recon, space or spec leaves it. Runs as the owner (security definer); its
-- search_path is the schema it was made in. EXECUTE is the owner's and, through db:migrate (migrateJobs), APP_DB_ROLE's.
create function recon_source_due(source_spaces uuid[], source_ids uuid[]) returns table (source_id uuid, grace_minutes int, deadline text, close_minutes int)
language sql stable security definer set search_path from current as $$
  select u.source_id, min(u.grace_minutes)::int, min(u.deadline), min(
    case when v.spec #>> '{schedule,kind}' = 'daily'
      then (v.spec #>> '{schedule,business_date_offset}')::int * 1440 + split_part(v.spec #>> '{schedule,at}', ':', 1)::int * 60 + split_part(v.spec #>> '{schedule,at}', ':', 2)::int
      else split_part(v.spec ->> 'close_at', ':', 1)::int * 60 + split_part(v.spec ->> 'close_at', ':', 2)::int
    end + (v.spec ->> 'grace_minutes')::int)::int
  from unnest(source_spaces, source_ids) as x(space_id, id)
  join recon_source_uses u on u.source_space_id = x.space_id and u.source_id = x.id
  join spaces s on s.id = u.space_id and s.status = 'active'
  join recon_config_versions v on v.space_id = u.space_id and v.config_id = u.config_id and v.status = 'published'
  group by u.source_id
$$;
--> statement-breakpoint
revoke execute on function recon_source_due(uuid[], uuid[]) from public;
