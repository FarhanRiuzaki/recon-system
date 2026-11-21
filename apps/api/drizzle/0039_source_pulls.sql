CREATE TABLE "source_pulls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"quarantined" integer DEFAULT 0 NOT NULL,
	"left_out" integer DEFAULT 0 NOT NULL,
	"watermark" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "source_pulls" ADD CONSTRAINT "source_pulls_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_pulls_source_started" ON "source_pulls" USING btree ("space_id","source_id","started_at" DESC NULLS LAST);--> statement-breakpoint
select recon_enable_space_rls('source_pulls');
