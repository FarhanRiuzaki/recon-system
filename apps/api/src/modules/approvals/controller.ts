// /v1/spaces/:spaceId/approvals (the inbox), …/approval-requests/:id (deciding a request, DEC-052) and
// …/workflows (a space's approval workflows). Any role of the space reads; who decides a request follows its chain
// (checked in the service: the guard can't know the chain); a space admin or a workflow.manage holder edits workflows.
import { Elysia } from "elysia";
import { ApprovalListQuery } from "@starterkit/shared/contracts/approvals";
import { ApproveBody, OverrideBody, PreviewWorkflowBody, RejectBody, ReviewWorkflowBody, SaveWorkflowBody } from "@starterkit/shared/contracts/workflows";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { WORKFLOW_ACTIONS, type WorkflowAction } from "@starterkit/shared/workflows";
import { notFound } from "../../kernel/errors";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { approveRequest, cancelRequest, overrideRequest, rejectRequest } from "./requests";
import { approvalFacets, approvalPage } from "./service";
import { discardDraft, previewWorkflow, reviewDraft, saveDraft, startDraft, submitDraft, workflowDetail, workflowList } from "./workflows";

/** A workflow's action from the path (WORKFLOW_ACTIONS); anything else is 404. */
const actionParam = (a: string | undefined): WorkflowAction => {
  if (!a || !(WORKFLOW_ACTIONS as readonly string[]).includes(a)) throw notFound("workflow");
  return a as WorkflowAction;
};

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
  .get("/v1/spaces/:spaceId/workflows", ({ ctx }) => workflowList(ctx), { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .get("/v1/spaces/:spaceId/workflows/:action", ({ ctx, params }) => workflowDetail(ctx, actionParam(params.action)), { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/preview", async (c) => {
    const b = await body(c, PreviewWorkflowBody);
    return previewWorkflow(c.ctx, actionParam(c.params.action), b);
  }, { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/draft", ({ ctx, params }) => startDraft(ctx, actionParam(params.action)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .patch("/v1/spaces/:spaceId/workflows/:action/draft", async (c) => {
    const b = await body(c, SaveWorkflowBody);
    return saveDraft(c.ctx, actionParam(c.params.action), b);
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/draft/submit", ({ ctx, params }) => submitDraft(ctx, actionParam(params.action)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/draft/discard", ({ ctx, params }) => discardDraft(ctx, actionParam(params.action)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/review/approve", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, actionParam(c.params.action), b, "approve");
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/workflows/:action/review/reject", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, actionParam(c.params.action), b, "reject");
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } });
