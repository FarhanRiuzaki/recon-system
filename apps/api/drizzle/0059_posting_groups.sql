CREATE TABLE "posting_group_items" (
	"group_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"action_index" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"ref" text,
	"amount_minor" bigint,
	"context" jsonb,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posting_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"config_version_id" uuid NOT NULL,
	"change" text NOT NULL,
	"action_index" smallint NOT NULL,
	"variant_index" smallint NOT NULL,
	"action_name" text NOT NULL,
	"variant_name" text NOT NULL,
	"keys" jsonb NOT NULL,
	"key_text" text NOT NULL,
	"currency" text NOT NULL,
	"period" date NOT NULL,
	"part" smallint DEFAULT 1 NOT NULL,
	"at" text NOT NULL,
	"closes_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"members" integer DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"run_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_groups_status_check" CHECK ("posting_groups"."status" in ('open', 'closed')),
	CONSTRAINT "posting_groups_at_check" CHECK ("posting_groups"."at" in ('cutoff', 'day_close'))
);
--> statement-breakpoint
ALTER TABLE "action_runs" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "action_runs" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_group_items" ADD CONSTRAINT "posting_group_items_group_id_posting_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "posting_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_group_items_once" ON "posting_group_items" USING btree ("request_id","action_index","item_id");--> statement-breakpoint
CREATE INDEX "posting_group_items_group" ON "posting_group_items" USING btree ("group_id","joined_at");--> statement-breakpoint
CREATE INDEX "posting_group_items_item" ON "posting_group_items" USING btree ("space_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_groups_once" ON "posting_groups" USING btree ("config_version_id","change","action_index","variant_index","key_text","currency","period","part");--> statement-breakpoint
CREATE INDEX "posting_groups_list" ON "posting_groups" USING btree ("space_id","config_id","period");--> statement-breakpoint
CREATE INDEX "posting_groups_due" ON "posting_groups" USING btree ("status","closes_at");--> statement-breakpoint
CREATE UNIQUE INDEX "action_runs_group" ON "action_runs" USING btree ("group_id") WHERE "action_runs"."group_id" is not null;--> statement-breakpoint
select recon_enable_space_rls('posting_groups');--> statement-breakpoint
select recon_enable_space_rls('posting_group_items');