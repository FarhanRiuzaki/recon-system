-- DEC-052 rev 2 (docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md §6): workflows belong to a
-- space; the approval setup moves into the recon version, so the per-space approval rules go. The workflows made so far
-- belong to no space (global library, dev test data only); they go, unless a pending request still runs on one of them.
do $$ begin
  if exists (select 1 from approval_requests r join workflow_versions v on v.id = r.workflow_version_id where r.status = 'pending') then
    raise exception 'a pending request runs on a workflow without a space: decide or cancel it first (DEC-052 rev 2)';
  end if;
end $$;
--> statement-breakpoint
update approval_requests set workflow_version_id = null where workflow_version_id is not null;
--> statement-breakpoint
delete from workflows;
--> statement-breakpoint
ALTER TABLE "approval_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "approval_bindings" CASCADE;--> statement-breakpoint
DROP INDEX "workflows_name";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "config_version_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "space_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "space_id" uuid NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_space_name" ON "workflows" USING btree ("space_id",lower("name"));--> statement-breakpoint
ALTER TABLE "approval_requests" DROP COLUMN "binding_version_id";
--> statement-breakpoint
select recon_enable_space_rls('workflows');
--> statement-breakpoint
select recon_enable_space_rls('workflow_versions');
