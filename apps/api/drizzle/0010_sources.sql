CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"weekend" integer[] NOT NULL,
	"holidays" date[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_weekend_check" CHECK ("calendars"."weekend" <@ array[1, 2, 3, 4, 5, 6, 7])
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"secret_enc" text NOT NULL,
	"options" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_connections_pkey" PRIMARY KEY("space_id","source_id"),
	CONSTRAINT "source_connections_engine_check" CHECK ("source_connections"."engine" in ('postgres', 'mysql', 'mssql', 'oracle'))
);
--> statement-breakpoint
CREATE TABLE "source_shares" (
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"to_space_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_shares_pkey" PRIMARY KEY("space_id","source_id","to_space_id"),
	CONSTRAINT "source_shares_not_self" CHECK ("source_shares"."to_space_id" <> "source_shares"."space_id")
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"spec" jsonb,
	"spec_hash" text,
	"maker_id" uuid,
	"checker_id" uuid,
	"review_comment" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_versions_version_key" UNIQUE("space_id","source_id","version"),
	CONSTRAINT "source_versions_status_check" CHECK ("source_versions"."status" in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('db_watermark', 'db_snapshot', 'file_inbox')),
	CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_shares" ADD CONSTRAINT "source_shares_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_shares" ADD CONSTRAINT "source_shares_to_space_id_fkey" FOREIGN KEY ("to_space_id") REFERENCES "spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_code_key" ON "calendars" USING btree ("code");--> statement-breakpoint
CREATE INDEX "source_shares_to_space_id" ON "source_shares" USING btree ("to_space_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_open_key" ON "source_versions" USING btree ("space_id","source_id") WHERE "source_versions"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "source_versions_published_key" ON "source_versions" USING btree ("space_id","source_id") WHERE "source_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "sources_space_id_code_key" ON "sources" USING btree ("space_id","code");