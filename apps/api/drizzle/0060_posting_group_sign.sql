DROP INDEX "posting_groups_once";--> statement-breakpoint
ALTER TABLE "posting_group_items" ADD COLUMN "context_enc" text;--> statement-breakpoint
ALTER TABLE "posting_groups" ADD COLUMN "negative" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_groups_once" ON "posting_groups" USING btree ("config_version_id","change","action_index","variant_index","key_text","currency","negative","period","part");--> statement-breakpoint
-- day-close groups from before their due moment was kept: due at the end of their period (Asia/Jakarta)
UPDATE "posting_groups" SET "closes_at" = ("period" + 1)::timestamp AT TIME ZONE 'Asia/Jakarta' WHERE "at" = 'day_close' AND "closes_at" IS NULL;
