CREATE TABLE "report_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"format" text NOT NULL,
	"masking" text NOT NULL,
	"status" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"file_name" text NOT NULL,
	"file_version" integer DEFAULT 1 NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" integer,
	"size" bigint,
	"sha256" text,
	"asked_by" uuid,
	"run_id" uuid,
	"error" text,
	"read_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_files_status_check" CHECK ("report_files"."status" in ('queued', 'making', 'ready', 'failed', 'removed')),
	CONSTRAINT "report_files_format_check" CHECK ("report_files"."format" in ('csv', 'xlsx', 'pdf')),
	CONSTRAINT "report_files_masking_check" CHECK ("report_files"."masking" in ('masked', 'full'))
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"name" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_templates_space_id_key" UNIQUE("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_template_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"spec" jsonb NOT NULL,
	"maker_id" uuid,
	"contributor_ids" uuid[] DEFAULT '{}' NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"checker_id" uuid,
	"note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_template_versions_version_key" UNIQUE("space_id","template_id","version"),
	CONSTRAINT "report_template_versions_status_check" CHECK ("report_template_versions"."status" in ('draft', 'waiting', 'active', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "report_files" ADD CONSTRAINT "report_files_template_fkey" FOREIGN KEY ("space_id","template_id") REFERENCES "report_templates"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_templates" ADD CONSTRAINT "report_templates_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_template_versions" ADD CONSTRAINT "report_template_versions_template_fkey" FOREIGN KEY ("space_id","template_id") REFERENCES "report_templates"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_files_run_key" ON "report_files" USING btree ("space_id","template_id","run_id") WHERE "report_files"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "report_files_list_idx" ON "report_files" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "report_files_template_idx" ON "report_files" USING btree ("space_id","template_id","from_date","to_date");--> statement-breakpoint
CREATE INDEX "report_templates_config_idx" ON "report_templates" USING btree ("space_id","config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_template_versions_open_key" ON "report_template_versions" USING btree ("space_id","template_id") WHERE "report_template_versions"."status" in ('draft', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "report_template_versions_active_key" ON "report_template_versions" USING btree ("space_id","template_id") WHERE "report_template_versions"."status" = 'active';