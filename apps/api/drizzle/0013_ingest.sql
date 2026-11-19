CREATE TABLE "quarantine_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"origin_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"raw" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"business_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quarantine_rows_origin_check" CHECK ("quarantine_rows"."origin" in ('file', 'pull', 'snapshot'))
);
--> statement-breakpoint
CREATE TABLE "raw_rows" (
	"id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"origin_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"line_no" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"business_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_rows_pkey" PRIMARY KEY("space_id","id","business_date"),
	CONSTRAINT "raw_rows_dedup_key" UNIQUE NULLS NOT DISTINCT("space_id","source_id","row_hash","business_date","snapshot_id"),
	CONSTRAINT "raw_rows_origin_check" CHECK ("raw_rows"."origin" in ('file', 'pull', 'snapshot'))

) partition by range (business_date);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"bday_index" integer NOT NULL,
	"ext_ref" text,
	"account_ref" text,
	"amount_minor" bigint,
	"currency" text,
	"direction" text,
	"event_time" timestamp (3) with time zone,
	"attrs" jsonb NOT NULL,
	"row_hash" text NOT NULL,
	"natural_key" text,
	"superseded_by" uuid,
	"snapshot_id" uuid,
	"origin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "records_pkey" PRIMARY KEY("space_id","id","business_date"),
	CONSTRAINT "records_dedup_key" UNIQUE NULLS NOT DISTINCT("space_id","source_id","row_hash","business_date","snapshot_id")

) partition by range (business_date);
--> statement-breakpoint
CREATE TABLE "source_cursors" (
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"watermark" text,
	"watermark_id" text,
	"complete_through" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"columns" jsonb,
	"columns_version_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_cursors_pkey" PRIMARY KEY("space_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "source_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"modified_at" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"version" integer,
	"version_of" uuid,
	"business_date" date,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_ok" integer DEFAULT 0 NOT NULL,
	"rows_new" integer DEFAULT 0 NOT NULL,
	"rows_quarantined" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_files_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "source_files_status_check" CHECK ("source_files"."status" in ('ingested', 'rejected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "source_snapshots_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "source_snapshots_status_check" CHECK ("source_snapshots"."status" in ('loading', 'active', 'failed', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "quarantine_rows" ADD CONSTRAINT "quarantine_rows_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_rows" ADD CONSTRAINT "raw_rows_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_cursors" ADD CONSTRAINT "source_cursors_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quarantine_rows_source_created" ON "quarantine_rows" USING btree ("space_id","source_id","created_at");--> statement-breakpoint
CREATE INDEX "records_source_date" ON "records" USING btree ("space_id","source_id","business_date");--> statement-breakpoint
CREATE INDEX "records_current_key" ON "records" USING btree ("space_id","source_id","natural_key") WHERE "records"."superseded_by" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_files_arrival_key" ON "source_files" USING btree ("space_id","source_id","name","size","modified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_files_ingested_key" ON "source_files" USING btree ("space_id","source_id","sha256") WHERE "source_files"."status" = 'ingested';--> statement-breakpoint
CREATE INDEX "source_files_source_received" ON "source_files" USING btree ("space_id","source_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_snapshots_active_key" ON "source_snapshots" USING btree ("space_id","source_id","business_date") WHERE "source_snapshots"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "source_snapshots_loading_key" ON "source_snapshots" USING btree ("space_id","source_id","business_date") WHERE "source_snapshots"."status" = 'loading';--> statement-breakpoint
CREATE INDEX "source_snapshots_source_date" ON "source_snapshots" USING btree ("space_id","source_id","business_date");