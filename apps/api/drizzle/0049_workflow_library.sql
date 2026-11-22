-- DEC-052 revision (docs/superpowers/specs/2026-11-22-workflow-library-and-bindings-design.md): a global workflow
-- library; a space's approval workflows become approval rules that pick a library workflow. Phase A rules carried their
-- levels inline; none exist outside dev (0 rows on 22 Nov), and they are never converted silently.
do $$ begin
  if exists (select 1 from approval_workflows w, jsonb_array_elements(w.spec->'rules') r where r ? 'levels') then
    raise exception 'approval_workflows has phase A rules with levels: convert them to library workflows first (DEC-052 revision)';
  end if;
end $$;
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
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
	CONSTRAINT "workflow_versions_status_check" CHECK (status in ('draft', 'in_review', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_workflows" RENAME TO "approval_bindings";--> statement-breakpoint
ALTER TABLE "approval_bindings" RENAME COLUMN "action" TO "trigger";--> statement-breakpoint
ALTER TABLE "approval_bindings" DROP CONSTRAINT "approval_workflows_status_check";--> statement-breakpoint
DROP INDEX "approval_workflows_one_open";--> statement-breakpoint
DROP INDEX "approval_workflows_one_published";--> statement-breakpoint
DROP INDEX "approval_workflows_version";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "binding_version_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "workflow_name" text;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_one_open" ON "workflow_versions" USING btree ("workflow_id") WHERE "workflow_versions"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_one_published" ON "workflow_versions" USING btree ("workflow_id") WHERE "workflow_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_version" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name" ON "workflows" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "approval_bindings_one_open" ON "approval_bindings" USING btree ("space_id","trigger") WHERE "approval_bindings"."status" in ('draft', 'in_review');--> statement-breakpoint
CREATE UNIQUE INDEX "approval_bindings_one_published" ON "approval_bindings" USING btree ("space_id","trigger") WHERE "approval_bindings"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_bindings_version" ON "approval_bindings" USING btree ("space_id","trigger","version");--> statement-breakpoint
ALTER TABLE "approval_bindings" ADD CONSTRAINT "approval_bindings_status_check" CHECK (status in ('draft', 'in_review', 'published', 'retired'));
--> statement-breakpoint
update approval_bindings set spec = jsonb_build_object('rules', spec->'rules', 'otherwise', null);
--> statement-breakpoint
-- the phase A version ids pointed at approval_workflows; the chain each request holds is its own snapshot
update approval_requests set workflow_version_id = null;
