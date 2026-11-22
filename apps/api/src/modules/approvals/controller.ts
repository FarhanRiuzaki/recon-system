// /v1/spaces/:spaceId/approvals (the inbox), …/approval-requests/:id (deciding a request, DEC-052), …/approval-rules
// (a space's approval rules) and /v1/workflows (the global workflow library). Any role of the space reads its inbox and
// rules; who decides a request follows its chain (checked in the service: the guard can't know the chain); a space admin
// or a workflow.manage holder edits rules; workflow.view reads the library, workflow.manage edits it.
import { Elysia } from "elysia";
import { ApprovalListQuery } from "@starterkit/shared/contracts/approvals";
import {
  ApproveBody, CreateWorkflowBody, OverrideBody, PreviewRulesBody, RejectBody, ReviewWorkflowBody, SaveChainBody, SaveRulesBody, UsedByQuery, WorkflowListQuery,
} from "@starterkit/shared/contracts/workflows";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { TRIGGERS, type Trigger } from "@starterkit/shared/workflows";
import { notFound } from "../../kernel/errors";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { approveRequest, cancelRequest, overrideRequest, rejectRequest } from "./requests";
import { approvalFacets, approvalPage } from "./service";
import { archiveWorkflow, createWorkflow, discardWorkflowDraft, libraryDetail, libraryPage, reviewWorkflowDraft, saveWorkflowDraft, startWorkflowDraft, submitWorkflowDraft, usedBy } from "./library";
import { discardDraft, previewRules, reviewDraft, rulesDetail, rulesList, saveDraft, startDraft, submitDraft } from "./rules";

/** A trigger from the path (TRIGGERS); anything else is 404. */
const triggerParam = (a: string | undefined): Trigger => {
  if (!a || !(TRIGGERS as readonly string[]).includes(a)) throw notFound("approval rules");
  return a as Trigger;
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
  // the space's approval rules
  .get("/v1/spaces/:spaceId/approval-rules", ({ ctx }) => rulesList(ctx), { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .get("/v1/spaces/:spaceId/approval-rules/:trigger", ({ ctx, params }) => rulesDetail(ctx, triggerParam(params.trigger)), { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/preview", async (c) => {
    const b = await body(c, PreviewRulesBody);
    return previewRules(c.ctx, triggerParam(c.params.trigger), b);
  }, { guard: { space: SPACE_ROLES, or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/draft", ({ ctx, params }) => startDraft(ctx, triggerParam(params.trigger)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .patch("/v1/spaces/:spaceId/approval-rules/:trigger/draft", async (c) => {
    const b = await body(c, SaveRulesBody);
    return saveDraft(c.ctx, triggerParam(c.params.trigger), b);
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/draft/submit", ({ ctx, params }) => submitDraft(ctx, triggerParam(params.trigger)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/draft/discard", ({ ctx, params }) => discardDraft(ctx, triggerParam(params.trigger)), { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/review/approve", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, triggerParam(c.params.trigger), b, "approve");
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } })
  .post("/v1/spaces/:spaceId/approval-rules/:trigger/review/reject", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewDraft(c.ctx, triggerParam(c.params.trigger), b, "reject");
  }, { guard: { space: ["space_admin"], or: "workflow.manage" } })
  // the workflow library
  .get("/v1/workflows", ({ query }) => libraryPage(query), { query: WorkflowListQuery, guard: "workflow.view" })
  .post("/v1/workflows", async (c) => {
    const b = await body(c, CreateWorkflowBody);
    return createWorkflow(c.ctx, b);
  }, { guard: "workflow.manage" })
  .get("/v1/workflows/:id", ({ ctx, params }) => libraryDetail(ctx, idParam(params.id, "workflow")), { guard: "workflow.view" })
  .get("/v1/workflows/:id/used-by", ({ params, query }) => usedBy(idParam(params.id, "workflow"), query), { query: UsedByQuery, guard: "workflow.view" })
  .post("/v1/workflows/:id/draft", ({ ctx, params }) => startWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: "workflow.manage" })
  .patch("/v1/workflows/:id/draft", async (c) => {
    const b = await body(c, SaveChainBody);
    return saveWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b);
  }, { guard: "workflow.manage" })
  .post("/v1/workflows/:id/draft/submit", ({ ctx, params }) => submitWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: "workflow.manage" })
  .post("/v1/workflows/:id/draft/discard", ({ ctx, params }) => discardWorkflowDraft(ctx, idParam(params.id, "workflow")), { guard: "workflow.manage" })
  .post("/v1/workflows/:id/review/approve", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b, "approve");
  }, { guard: "workflow.manage" })
  .post("/v1/workflows/:id/review/reject", async (c) => {
    const b = await body(c, ReviewWorkflowBody);
    return reviewWorkflowDraft(c.ctx, idParam(c.params.id, "workflow"), b, "reject");
  }, { guard: "workflow.manage" })
  .post("/v1/workflows/:id/archive", ({ ctx, params }) => archiveWorkflow(ctx, idParam(params.id, "workflow")), { guard: "workflow.manage" });
