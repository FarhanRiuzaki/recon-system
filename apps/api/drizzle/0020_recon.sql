CREATE TABLE "recon_config_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"config_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"maker_id" uuid,
	"contributor_ids" uuid[] DEFAULT '{}' NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"checker_id" uuid,
	"review_comment" text,
	"published_at" timestamp with time zone,
	"simulated_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_config_versions_version_key" UNIQUE("space_id","config_id","version"),
	CONSTRAINT "recon_config_versions_status_check" CHECK ("recon_config_versions"."status" in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "recon_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recon_configs_space_id_id_key" UNIQUE("space_id","id"),
	CONSTRAINT "recon_configs_status_check" CHECK ("recon_configs"."status" in ('active', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "recon_source_uses" (
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"source_space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"field" text NOT NULL,
	"config_name" text NOT NULL,
	CONSTRAINT "recon_source_uses_pkey" PRIMARY KEY("space_id","config_id","source_id","field")
);
--> statement-breakpoint
ALTER TABLE "recon_config_versions" ADD CONSTRAINT "recon_config_versions_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_configs" ADD CONSTRAINT "recon_configs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_source_uses" ADD CONSTRAINT "recon_source_uses_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recon_source_uses" ADD CONSTRAINT "recon_source_uses_source_fkey" FOREIGN KEY ("source_space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recon_config_versions_open_key" ON "recon_config_versions" USING btree ("space_id","config_id") WHERE "recon_config_versions"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "recon_config_versions_published_key" ON "recon_config_versions" USING btree ("space_id","config_id") WHERE "recon_config_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "recon_configs_space_id_code_key" ON "recon_configs" USING btree ("space_id","code");--> statement-breakpoint
CREATE INDEX "recon_source_uses_source" ON "recon_source_uses" USING btree ("source_space_id","source_id","field");