CREATE TABLE "action_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"config_version_id" uuid NOT NULL,
	"action_index" smallint NOT NULL,
	"action_name" text NOT NULL,
	"variant_name" text,
	"kind" text NOT NULL,
	"event" text NOT NULL,
	"level" smallint,
	"item_id" uuid,
	"seq" integer NOT NULL,
	"override" boolean DEFAULT false NOT NULL,
	"connector_id" uuid,
	"connector_version" integer,
	"operation_key" text,
	"status" text NOT NULL,
	"payload_enc" text,
	"payload_masked" jsonb,
	"response_masked" jsonb,
	"sources" jsonb,
	"filled" jsonb,
	"external_id" text,
	"bank_reference" text,
	"http_status" smallint,
	"code" text,
	"message" text,
	"sending_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_runs_status_check" CHECK (status in ('queued', 'sending', 'posted', 'failed', 'not_sent', 'timeout', 'no_rule', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runs_once" ON "action_runs" USING btree ("request_id","action_index","event",coalesce("level", 0),coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "action_runs_request" ON "action_runs" USING btree ("space_id","request_id","seq");--> statement-breakpoint
CREATE INDEX "action_runs_item" ON "action_runs" USING btree ("space_id","item_id");--> statement-breakpoint
CREATE INDEX "action_runs_sending" ON "action_runs" USING btree ("status","sending_at");--> statement-breakpoint
select recon_enable_space_rls('action_runs');
