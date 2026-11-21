-- A run's per-date result (ReconRunDto.days), written once when it succeeds so GET run never scans 31 days of groups.
-- Note for 0029: items broken before it have no break_pass (they show under no pass's breaks).
ALTER TABLE "recon_runs" ADD COLUMN "days" jsonb;