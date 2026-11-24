// /v1/spaces/:spaceId/approvals (the inbox), …/approval-requests/:id (deciding a request, DEC-052) and …/workflows (the
// space's workflows, DEC-052 rev 2). Any role of the space reads; who decides a request follows its chain (checked in
// the service: the guard can't know the chain); workflow.view also reads any space's workflows, and a space admin or a workflow.manage holder edits them.
import { Elysia } from "elysia";
import { ApprovalListQuery } from "@starterkit/shared/contracts/approvals";
import { ApproveBody, CreateWorkflowBody, OverrideBody, RejectBody, ReviewWorkflowBody, SaveChainBody, UsedByQuery, WorkflowListQuery } from "@starterkit/shared/contracts/workflows";
import { SPACE_ACTION, SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { approveRequest, cancelRequest, overrideRequest, rejectRequest } from "./requests";
import { approvalFacets, approvalPage } from "./service";
import {
  archiveWorkflow, createWorkflow, discardWorkflowDraft, reviewWorkflowDraft, saveWorkflowDraft, startWorkflowDraft, submitWorkflowDraft, usedBy, workflowDetail, workflowPage,
} from "./workflows";

export const approvalsController = () => new Elysia().use(guard)
  .get("/v1/spaces/:spaceId/approvals", ({ ctx, query }) => approvalPage(ctx, query), { query: ApprovalListQuery, guard: { space: SPACE_ROLES } })
  .get("/v1/spaces/:spaceId/approvals/facets", ({ ctx, query }) => approvalFacets(ctx, query), { query: ApprovalListQuery, guard: { space: SPACE_ROLES } })
  // deciding a request: whoever its chain's current level names (approve, reject), a Superadmin by override, its asker cancels
  .post("/v1/spaces/:spaceId/approval-requests/:id/approve", async (c) => {
    const b = await body(c, ApproveBody);
    return approveRequest(c.ctx, idParam(c.params.id, "request"), b);
  }, { guard: { space: SPACE_ROLES } })
  .post("/v1/spaces/:spaceId/approval-requests/:id/reject", async (c) => {
    const b = await body(c, RejectBody);
    return rejectRequest(c.ctx, idParam(c.params.id, "request"), b);
  }, { guard: { space: SPACE_ROLES } })
  .post("/v1/spaces/:spaceId/approval-requests/:id/override", async (c) => {
    const b = await body(c, OverrideBody);
    return overrideRequest(c.ctx, idParam(c.params.id, "request"), b);
  }, { guard: { space: SPACE_ROLES } })
  .post("/v1/spaces/:spaceId/approval-requests/:id/cancel", ({ ctx, params }) => cancelRequest(ctx, idParam(params.id, "request")), { guard: { space: SPACE_ROLES } })
  // the space's workflows
  .get("/v1/spaces/:spaceId/workflows", ({ ctx, query }) => workflowPage(ctx, query), { query: WorkflowListQuery, guard: { space: SPACE_ROLES, or: "workflow.view" } })
  .post("/v1/spaces/:spaceId/workflows", async (c) => {
    const b = await body(c, CreateWorkflowBody);
    return createWorkflow(c.ctx, b);
  }, { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .get("/v1/spaces/:spaceId/workflows/:id", ({ ctx, params }) => workflowDetail(ctx, idParam(params.id, "workflow")), { guard: { space: SPACE_ROLES, or: "workflow.view" } })
  .get("/v1/spaces/:spaceId/workflows/:id/used-by", ({ ctx, params, query }) => usedBy(ctx, idParam(params.id, "workflow"), query), { query: UsedByQuery, guard: { space: SPACE_ROLES, or: "workflow.view" } })
  .post("/v1/spaces/:spaceId/workflows/:id/draft", ({ ctx, params }) => startWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .patch("/v1/spaces/:spaceId/workflows/:id/draft", async (c) => {
    const b = await body(c, SaveChainBody);
    return saveWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b);
  }, { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:id/draft/submit", ({ ctx, params }) => submitWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:id/draft/discard", ({ ctx, params }) => discardWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:id/review/approve", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b, "approve");
  }, { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:id/review/reject", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b, "reject");
  }, { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:id/archive", ({ ctx, params }) => archiveWorkflow(ctx, idParam(params.id, "workflow")), { guard: { space: SPACE_ACTION.editWorkflows, or: "workflow.manage" } });
