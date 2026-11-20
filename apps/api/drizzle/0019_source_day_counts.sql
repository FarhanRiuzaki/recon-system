-- Records today and quarantined today as counters per source, business date and kind (ingest/schema.ts
-- source_day_counts explains how ingest keeps them current). The standard space policy (0009) for every command, and
-- for a space a source is shared to, its records counters only (a SELECT policy, as 0014): quarantine stays the owner's.
-- Counters of the data already there are built from it first. The owner runs this under FORCE ROW LEVEL SECURITY with
-- no space set, which would read no row: forcing is lifted on the tables read for these statements and put back, and
-- the new table gets its policy after it is filled.
CREATE TABLE "source_day_counts" (
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" text NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "source_day_counts_pkey" PRIMARY KEY("space_id","source_id","business_date","kind"),
	CONSTRAINT "source_day_counts_kind_check" CHECK ("source_day_counts"."kind" in ('records', 'quarantined'))
);
--> statement-breakpoint
ALTER TABLE "source_day_counts" ADD CONSTRAINT "source_day_counts_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "records" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_snapshots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quarantine_rows" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "source_day_counts" ("space_id", "source_id", "business_date", "kind", "n")
  SELECT r."space_id", r."source_id", r."business_date", 'records', count(*)::int FROM "records" r
  WHERE r."superseded_by" IS NULL AND (r."snapshot_id" IS NULL OR EXISTS (SELECT FROM "source_snapshots" s
    WHERE s."space_id" = r."space_id" AND s."id" = r."snapshot_id" AND s."status" = 'active'))
  GROUP BY r."space_id", r."source_id", r."business_date";--> statement-breakpoint
INSERT INTO "source_day_counts" ("space_id", "source_id", "business_date", "kind", "n")
  SELECT q."space_id", q."source_id", coalesce(q."business_date", (q."created_at" AT TIME ZONE 'Asia/Jakarta')::date), 'quarantined', count(*)::int
  FROM "quarantine_rows" q GROUP BY 1, 2, 3;--> statement-breakpoint
ALTER TABLE "records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quarantine_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
select recon_enable_space_rls('source_day_counts');--> statement-breakpoint
create policy source_day_counts_shared on source_day_counts for select using (kind = 'records' and exists (
  select from source_shares s where s.space_id = source_day_counts.space_id and s.source_id = source_day_counts.source_id and recon_space_visible(s.to_space_id)));
