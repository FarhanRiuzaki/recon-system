CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"group_index" smallint,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"override" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_decision_check" CHECK (decision in ('approve', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "approval_workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"spec" jsonb NOT NULL,
	"maker_id" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"review_comment" text,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_workflows_status_check" CHECK (status in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "workflow_version_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "rule_name" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "current_level" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_one_per_person" ON "approval_decisions" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE INDEX "approval_decisions_request" ON "approval_decisions" USING btree ("request_id","level");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_workflows_one_open" ON "approval_workflows" USING btree ("space_id","action") WHERE "approval_workflows"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "approval_workflows_one_published" ON "approval_workflows" USING btree ("space_id","action") WHERE "approval_workflows"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_workflows_version" ON "approval_workflows" USING btree ("space_id","action","version");--> statement-breakpoint
select recon_enable_space_rls('approval_workflows');
--> statement-breakpoint
select recon_enable_space_rls('approval_decisions');
--> statement-breakpoint
-- requests asked before the engine (Plan 5 Task 3) take today's rule as their chain: one level, any reviewer or space admin
update approval_requests set chain = '[{"name":"Checker","groups":[{"spaceRoles":["reviewer","space_admin"],"globalRoles":[],"users":[],"need":{"kind":"any"}}]}]'::jsonb where chain = '[]'::jsonb;
