// /v1/spaces/:spaceId/recons*: every route takes the space guard without `or` (a platform admin has no data access), so
// in an archived space each change is 409 space_archived. Roles (spec §11, Plan 3): any role reads; config_maker
// creates, drafts, edits and submits; config_checker approves or rejects a version someone else made; config_maker or
// space_admin deletes a draft recon never submitted (README row Plan 3). Query 400 → guard 401/403 → body 400 → 404 →
// rules → change → activity (the last four in service.ts).
import { Elysia } from "elysia";
import { CreateReconBody, PreviewApprovalBody, ReconActivityQuery, ReconListQuery, ReconVersionListQuery, RejectReconVersionBody, UpdateReconVersionBody } from "@starterkit/shared/contracts/recon";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  previewVersionApproval,
  approveVersion, createDraft, createRecon, discardRecon, reconActivity, reconDetail, reconPage, refusedRecon, rejectVersion, submitVersion, updateVersion,
  versionDetail, versionPage,
} from "./service";

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
    }, { guard: { space: ["config_maker"] } })
    .get("/v1/spaces/:spaceId/recons/:configId", ({ ctx, params }) => reconDetail(ctx, idParam(params.configId, "recon")), { guard: { space: SPACE_ROLES } })
    /** A draft recon never submitted, deleted with its draft. */
    .delete("/v1/spaces/:spaceId/recons/:configId", async ({ ctx, params }) => {
      await discardRecon(ctx, idParam(params.configId, "recon"));
      return { ok: true };
    }, { guard: { space: ["config_maker", "space_admin"] } })
    .get("/v1/spaces/:spaceId/recons/:configId/activity", ({ ctx, params, query }) =>
      reconActivity(ctx, idParam(params.configId, "recon"), query), { query: ReconActivityQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/versions", ({ ctx, params, query }) =>
      versionPage(ctx, idParam(params.configId, "recon"), query), { query: ReconVersionListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", ({ ctx, params }) =>
      versionDetail(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions", async (c) => {
      const v = await createDraft(c.ctx, idParam(c.params.configId, "recon"));
      c.set.status = 201;
      return v;
    }, { guard: { space: ["config_maker"] } })
    .patch("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", async (c) => {
      const b = await body(c, UpdateReconVersionBody).catch(refusedRecon);
      return updateVersion(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: ["config_maker"] } })
    // a read sent as POST for its body (typed field values): who would approve a change, nothing is written
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/approvals/preview", async (c) => {
      const b = await body(c, PreviewApprovalBody);
      return previewVersionApproval(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/submit", ({ ctx, params }) =>
      submitVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: ["config_maker"] } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/approve", ({ ctx, params }) =>
      approveVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version")), { guard: { space: ["config_checker"] } })
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/reject", async (c) => {
      const b = await body(c, RejectReconVersionBody);
      return rejectVersion(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: ["config_checker"] } });
