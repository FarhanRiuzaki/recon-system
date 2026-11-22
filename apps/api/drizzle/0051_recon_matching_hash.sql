-- DEC-052 rev 2: a recon version's approval setup lives in its spec, and an approval-only change needs no new
-- simulation; the simulation is checked against the spec's hash without the approval setup. No version has an approval
-- setup yet, so that hash is today's spec hash.
ALTER TABLE "recon_config_versions" ADD COLUMN "matching_hash" text;--> statement-breakpoint
update recon_config_versions set matching_hash = spec_hash;--> statement-breakpoint
ALTER TABLE "recon_config_versions" ALTER COLUMN "matching_hash" SET NOT NULL;
