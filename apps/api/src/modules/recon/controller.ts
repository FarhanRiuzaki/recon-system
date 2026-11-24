// /v1/spaces/:spaceId/recons*: every route takes the space guard without `or` (a platform admin has no data access), so
// in an archived space each change is 409 space_archived. Roles (spec §11, Plan 3): any role reads; config_maker
// creates, drafts, edits and submits; config_checker approves or rejects a version someone else made; config_maker or
// space_admin deletes a draft recon never submitted (README row Plan 3). Query 400 → guard 401/403 → body 400 → 404 →
// rules → change → activity (the last four in service.ts).
import { Elysia } from "elysia";
import { CreateReconBody, PreviewActionBody, PreviewApprovalBody, ReconActivityQuery, ReconListQuery, ReconVersionListQuery, RejectReconVersionBody, UpdateReconVersionBody } from "@starterkit/shared/contracts/recon";
import { ResultColumnsBody } from "@starterkit/shared/contracts/results";
import { SPACE_ACTION, SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  previewVersionAction,
  previewVersionApproval,
  approveVersion, createDraft, createRecon, discardRecon, reconActivity, reconDetail, reconPage, refusedRecon, rejectVersion, submitVersion, updateVersion,
  versionDetail, versionPage,
} from "./service";
import { resultColumns, setResultColumns } from "./result-columns";

/** The routes of /v1/spaces/:spaceId/recons*. */
export const reconController = () =>
  new Elysia()
    .use(guard)
    .get("/v1/spaces/:spaceId/recons", ({ ctx, query }) => reconPage(ctx, query), { query: ReconListQuery, guard: { space: SPACE_ROLES } })
    /** The first save: the recon and its draft version 1. */
    .post("/v1/spaces/:spaceId/recons", async (c) => {
      const r = await createRecon(c.ctx, await body(c, CreateReconBody).catch(refusedRecon));
      c.set.status = 201;
      return r;
    }, { guard: { space: SPACE_ACTION.editRecon } })
    .get("/v1/spaces/:spaceId/recons/:configId", ({ ctx, params }) => reconDetail(ctx, idParam(params.configId, "recon")), { guard: { space: SPACE_ROLES } })
    /** A draft recon never submitted, deleted with its draft. */
    .delete("/v1/spaces/:spaceId/recons/:configId", async ({ ctx, params }) => {
      await discardRecon(ctx, idParam(params.configId, "recon"));
      return { ok: true };
    }, { guard: { space: SPACE_ACTION.deleteRecon } })
    .get("/v1/spaces/:spaceId/recons/:configId/activity", ({ ctx, params, query }) =>
      reconActivity(ctx, idParam(params.configId, "recon"), query), { query: ReconActivityQuery, guard: { space: SPACE_ROLES } })
    // the Operation result columns: outside the versioned spec, no approval; any role reads, a config maker or space admin saves
    .get("/v1/spaces/:spaceId/recons/:configId/result-columns", ({ ctx, params }) => resultColumns(ctx, idParam(params.configId, "recon")), { guard: { space: SPACE_ROLES } })
    .put("/v1/spaces/:spaceId/recons/:configId/result-columns", async (c) => {
      const b = await body(c, ResultColumnsBody);
      return setResultColumns(c.ctx, idParam(c.params.configId, "recon"), b);
    }, { guard: { space: SPACE_ACTION.resultColumns } })
    .get("/v1/spaces/:spaceId/recons/:configId/versions", ({ ctx, params, query }) =>
      versionPage(ctx, idParam(params.configId, "recon"), query), { query: ReconVersionListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", ({ ctx, params }) =>
      versionDetail(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions", async (c) => {
      const v = await createDraft(c.ctx, idParam(c.params.configId, "recon"));
      c.set.status = 201;
      return v;
    }, { guard: { space: SPACE_ACTION.editRecon } })
    .patch("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", async (c) => {
      const b = await body(c, UpdateReconVersionBody).catch(refusedRecon);
      return updateVersion(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: SPACE_ACTION.editRecon } })
    // a read sent as POST for its body (typed field values): who would approve a change, nothing is written
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/approvals/preview", async (c) => {
      const b = await body(c, PreviewApprovalBody);
      return previewVersionApproval(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: SPACE_ROLES } })
    // a read sent as POST for its body: what an action would send for a real break (stage 4), nothing is written
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/actions/preview", async (c) => {
      const b = await body(c, PreviewActionBody);
      return previewVersionAction(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: SPACE_ACTION.previewPosting } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/submit", ({ ctx, params }) =>
      submitVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: SPACE_ACTION.editRecon } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/approve", ({ ctx, params }) =>
      approveVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: SPACE_ACTION.approveVersion } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/reject", async (c) => {
      const b = await body(c, RejectReconVersionBody);
      return rejectVersion(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: SPACE_ACTION.approveVersion } });
