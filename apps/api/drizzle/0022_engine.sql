CREATE TABLE "match_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"config_version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"pass_no" smallint NOT NULL,
	"kind" text NOT NULL,
	"score" numeric,
	"business_date" date NOT NULL,
	"evidence" jsonb NOT NULL,
	"reversed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_groups_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "match_groups_kind_check" CHECK ("match_groups"."kind" in ('auto', 'suggested', 'manual', 'force'))
);
--> statement-breakpoint
CREATE TABLE "match_members" (
	"group_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"side" text NOT NULL,
	"signed_amount" bigint,
	CONSTRAINT "match_members_pkey" PRIMARY KEY("space_id","group_id","item_id"),
	CONSTRAINT "match_members_side_check" CHECK ("match_members"."side" in ('a', 'b'))
);
--> statement-breakpoint
CREATE TABLE "recon_items" (
	"id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"business_date" date NOT NULL,
	"break_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"sim_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_items_pkey" PRIMARY KEY("space_id","id","business_date"),
	CONSTRAINT "recon_items_record_key" UNIQUE NULLS NOT DISTINCT("space_id","config_id","record_id","business_date","sim_run_id"),
	CONSTRAINT "recon_items_side_check" CHECK ("recon_items"."side" in ('a', 'b')),
	CONSTRAINT "recon_items_status_check" CHECK ("recon_items"."status" in ('open', 'matched', 'suggested', 'break', 'closed'))

) partition by range (business_date);
--> statement-breakpoint
CREATE TABLE "recon_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"config_version_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "recon_runs_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "recon_runs_mode_check" CHECK ("recon_runs"."mode" in ('manual', 'tick', 'daily', 'rerun', 'simulation')),
	CONSTRAINT "recon_runs_status_check" CHECK ("recon_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "recon_runs_window_check" CHECK ("recon_runs"."date_from" <= "recon_runs"."date_to")
);
--> statement-breakpoint
ALTER TABLE "match_groups" ADD CONSTRAINT "match_groups_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_groups" ADD CONSTRAINT "match_groups_run_fkey" FOREIGN KEY ("space_id","run_id") REFERENCES "recon_runs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_members" ADD CONSTRAINT "match_members_group_fkey" FOREIGN KEY ("space_id","group_id") REFERENCES "match_groups"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_items" ADD CONSTRAINT "recon_items_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_items" ADD CONSTRAINT "recon_items_sim_run_fkey" FOREIGN KEY ("space_id","sim_run_id") REFERENCES "recon_runs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_groups_config_date" ON "match_groups" USING btree ("space_id","config_id","business_date");--> statement-breakpoint
CREATE INDEX "match_groups_run" ON "match_groups" USING btree ("space_id","run_id","pass_no");--> statement-breakpoint
CREATE INDEX "match_members_item" ON "match_members" USING btree ("space_id","item_id");--> statement-breakpoint
CREATE INDEX "recon_items_open" ON "recon_items" USING btree ("space_id","config_id","sim_run_id","side","business_date") WHERE "recon_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "recon_items_config_date" ON "recon_items" USING btree ("space_id","config_id","business_date");--> statement-breakpoint
CREATE INDEX "recon_runs_config_started" ON "recon_runs" USING btree ("space_id","config_id","started_at");