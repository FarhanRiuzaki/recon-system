-- The quarantine key per origin (review ruling, replaces 0017's one key): a file's or snapshot's line is kept once per
-- line (origin_id, line_no), so a file's rows_quarantined equals the lines shown; a pulled line once per raw_hash, since a
-- pull reads its lookback again on every run. A pulled line has no business date, so its key leaves it out.
ALTER TABLE "quarantine_rows" DROP CONSTRAINT "quarantine_rows_dedup_key";--> statement-breakpoint
CREATE UNIQUE INDEX "quarantine_rows_pull_key" ON "quarantine_rows" USING btree ("space_id","source_id","raw_hash") WHERE "quarantine_rows"."origin" = 'pull';--> statement-breakpoint
CREATE UNIQUE INDEX "quarantine_rows_line_key" ON "quarantine_rows" USING btree ("space_id","source_id","origin","origin_id","line_no") WHERE "quarantine_rows"."origin" <> 'pull';