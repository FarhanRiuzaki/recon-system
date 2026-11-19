ALTER TABLE "source_versions" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "source_versions" ADD COLUMN "submitted_at" timestamp with time zone;