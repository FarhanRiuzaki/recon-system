CREATE TABLE "import_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed_id" uuid NOT NULL,
	"run_id" uuid,
	"file_date" date NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"result" text NOT NULL,
	"rows" integer,
	"inserted" integer,
	"replaced" integer,
	"history_id" uuid,
	"message" text,
	"user_id" uuid,
	CONSTRAINT "import_checks_trigger_check" CHECK ("import_checks"."trigger" in ('schedule', 'manual')),
	CONSTRAINT "import_checks_result_check" CHECK ("import_checks"."result" in ('not_ready', 'imported', 'skipped', 'failed', 'dry_run'))
);
--> statement-breakpoint
CREATE TABLE "import_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'db_host' NOT NULL,
	"spec" jsonb NOT NULL,
	"scheduler_on" boolean DEFAULT false NOT NULL,
	"table_state" text DEFAULT 'missing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "import_feeds_kind_check" CHECK ("import_feeds"."kind" in ('db_host')),
	CONSTRAINT "import_feeds_table_state_check" CHECK ("import_feeds"."table_state" in ('missing', 'created', 'adopted'))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feed_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"dates" integer DEFAULT 0 NOT NULL,
	"message" text,
	"user_id" uuid,
	CONSTRAINT "import_runs_trigger_check" CHECK ("import_runs"."trigger" in ('schedule', 'manual')),
	CONSTRAINT "import_runs_status_check" CHECK ("import_runs"."status" in ('running', 'done', 'failed', 'crashed'))
);
--> statement-breakpoint
ALTER TABLE "import_checks" ADD CONSTRAINT "import_checks_feed_id_import_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "import_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_feed_id_import_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "import_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_checks_feed_date" ON "import_checks" USING btree ("feed_id","file_date","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_checks_at" ON "import_checks" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_feeds_name_key" ON "import_feeds" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "import_feeds_history_source_key" ON "import_feeds" USING btree (("spec" ->> 'historySource'));--> statement-breakpoint
CREATE INDEX "import_runs_feed_started" ON "import_runs" USING btree ("feed_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_runs_running" ON "import_runs" USING btree ("feed_id") WHERE "import_runs"."status" = 'running';