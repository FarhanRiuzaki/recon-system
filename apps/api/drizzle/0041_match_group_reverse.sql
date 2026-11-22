ALTER TABLE "match_groups" ADD COLUMN "reverse_reason" text;--> statement-breakpoint
ALTER TABLE "match_groups" ADD COLUMN "reversed_at" timestamp with time zone;