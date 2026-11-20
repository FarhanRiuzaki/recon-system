CREATE TABLE "recon_days" (
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"incomplete" jsonb,
	"counters" jsonb,
	"closing_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "recon_days_pkey" PRIMARY KEY("space_id","config_id","business_date"),
	CONSTRAINT "recon_days_status_check" CHECK ("recon_days"."status" in ('closing', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "recon_items" ADD COLUMN "late_match" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recon_items" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "recon_source_uses" ADD COLUMN "grace_minutes" integer;--> statement-breakpoint
ALTER TABLE "recon_source_uses" ADD COLUMN "deadline" text;--> statement-breakpoint
ALTER TABLE "recon_days" ADD CONSTRAINT "recon_days_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recon_items_late" ON "recon_items" USING btree ("space_id","config_id","sim_run_id","side","business_date") WHERE "recon_items"."status" = 'break' and "recon_items"."late_match";--> statement-breakpoint
-- A config's days are space data like its runs (0009 standard policy, every command).
select recon_enable_space_rls('recon_days');
--> statement-breakpoint
-- The health inputs of configs published before this migration, from their published spec (approve writes them from
-- now on). Under FORCE ROW LEVEL SECURITY a role that is not a superuser sees no row here: those configs get theirs at
-- their next publish.
update recon_source_uses u set
  grace_minutes = nullif((v.spec ->> 'grace_minutes')::int, 0),
  deadline = case when v.spec -> 'schedule' ->> 'kind' = 'daily' then v.spec -> 'schedule' ->> 'at' else v.spec ->> 'close_at' end
from recon_config_versions v
where v.space_id = u.space_id and v.config_id = u.config_id and v.status = 'published';
