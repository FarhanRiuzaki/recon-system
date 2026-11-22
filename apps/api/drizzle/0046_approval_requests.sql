CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"label" text NOT NULL,
	"note" text NOT NULL,
	"prev_state" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "approval_requests_kind_check" CHECK (kind in ('force_match', 'unmatch', 'write_off')),
	CONSTRAINT "approval_requests_status_check" CHECK (status in ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_config_fkey" FOREIGN KEY ("space_id","config_id") REFERENCES "recon_configs"("space_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending" ON "approval_requests" USING btree ("space_id","item_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_inbox" ON "approval_requests" USING btree ("space_id","status","requested_at");--> statement-breakpoint
select recon_enable_space_rls('approval_requests');