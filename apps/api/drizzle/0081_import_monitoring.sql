CREATE TABLE "import_heartbeat" (
	"key" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_feeds" ADD COLUMN "scheduler_changed_at" timestamp with time zone;