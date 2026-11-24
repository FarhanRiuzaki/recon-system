-- When each business date of a source became complete (ingest/schema.ts source_deliveries): the standard space policy
-- (0009) for every command, and for a space the source is shared to a read of them (a SELECT policy, as 0014), so a
-- recon there sees its sources on time or late. No backfill: dates completed before this table count as unknown.
CREATE TABLE "source_deliveries" (
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_deliveries_pkey" PRIMARY KEY("space_id","source_id","business_date")
);
--> statement-breakpoint
ALTER TABLE "source_deliveries" ADD CONSTRAINT "source_deliveries_source_fkey" FOREIGN KEY ("space_id","source_id") REFERENCES "sources"("space_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
select recon_enable_space_rls('source_deliveries');
--> statement-breakpoint
create policy source_deliveries_shared on source_deliveries for select using (exists (
  select from source_shares s where s.space_id = source_deliveries.space_id and s.source_id = source_deliveries.source_id and recon_space_visible(s.to_space_id)));
