-- A quarantined line once per (origin, raw_hash, business_date): a watermark pull reads its lookback again on every run,
-- so the same bad row was quarantined again each minute. raw_hash = SHA-256 (hex) of the line's text as UTF-8, as the
-- app computes it (ingest/service.ts writeLines). Lines already stored get their hash here and keep the oldest of each
-- key (UUIDv7 ids sort by creation). The owner runs this under FORCE ROW LEVEL SECURITY with no space set, which would
-- see no row: forcing is lifted for these statements and put back before the transaction ends.
ALTER TABLE "quarantine_rows" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quarantine_rows" ADD COLUMN "raw_hash" text;--> statement-breakpoint
UPDATE "quarantine_rows" SET "raw_hash" = encode(sha256(convert_to("raw", 'UTF8')), 'hex');--> statement-breakpoint
DELETE FROM "quarantine_rows" a USING "quarantine_rows" b
  WHERE a."space_id" = b."space_id" AND a."source_id" = b."source_id" AND a."origin" = b."origin" AND a."raw_hash" = b."raw_hash"
    AND a."business_date" IS NOT DISTINCT FROM b."business_date" AND a."id" > b."id";--> statement-breakpoint
ALTER TABLE "quarantine_rows" ALTER COLUMN "raw_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quarantine_rows" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quarantine_rows" ADD CONSTRAINT "quarantine_rows_dedup_key" UNIQUE NULLS NOT DISTINCT("space_id","source_id","origin","raw_hash","business_date");
