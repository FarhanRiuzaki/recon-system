// /v1/spaces/:spaceId/sources*: every route takes the space guard without `or` (a platform admin has no data access),
// so in an archived space each change is 409 space_archived. Roles (spec §11, Plan 2): any role reads; source_admin
// creates a source and sets its connection; source_admin or config_maker drafts, edits and submits a version;
// config_checker approves or rejects one someone else made; space_admin shares. Query 400 → guard 401/403 → body 400 →
// 404 → rules → change → activity (the last four in service.ts).
import { Elysia } from "elysia";
import { CreateSourceBody, PreviewSourceBody, RejectSourceVersionBody, SetConnectionBody, SourceListQuery, UpdateSourceVersionBody } from "@starterkit/shared/contracts/sources";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  approveVersion, createDraft, createSource, previewVersion, rejectVersion, setConnection, shareSource, sourceDetail, sourcePage, submitVersion, unshareSource, updateVersion,
} from "./service";

const MAKERS = ["source_admin", "config_maker"] as const;

/** The routes of /v1/spaces/:spaceId/sources*. */
export const sourcesController = () =>
  new Elysia()
    .use(guard)
    /** The space's sources and those shared to it. */
    .get("/v1/spaces/:spaceId/sources", ({ ctx, query }) => sourcePage(ctx, query), { query: SourceListQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/sources", async (c) => {
      const s = await createSource(c.ctx, await body(c, CreateSourceBody));
      c.set.status = 201;
      return s;
    }, { guard: { space: ["source_admin"] } })
    .get("/v1/spaces/:spaceId/sources/:sourceId", ({ ctx, params }) => sourceDetail(ctx, idParam(params.sourceId, "source")), { guard: { space: SPACE_ROLES } })
    .put("/v1/spaces/:spaceId/sources/:sourceId/connection", async (c) => {
      const b = await body(c, SetConnectionBody);
      return setConnection(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions", async (c) => {
      const v = await createDraft(c.ctx, idParam(c.params.sourceId, "source"));
      c.set.status = 201;
      return v;
    }, { guard: { space: MAKERS } })
    .patch("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId", async (c) => {
      const b = await body(c, UpdateSourceVersionBody);
      return updateVersion(c.ctx, idParam(c.params.sourceId, "source"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: MAKERS } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/preview", async (c) => {
      const b = await body(c, PreviewSourceBody);
      return previewVersion(c.ctx, idParam(c.params.sourceId, "source"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: MAKERS } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/submit", ({ ctx, params }) =>
      submitVersion(ctx, idParam(params.sourceId, "source"), idParam(params.versionId, "version")), { guard: { space: MAKERS } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/approve", ({ ctx, params }) =>
      approveVersion(ctx, idParam(params.sourceId, "source"), idParam(params.versionId, "version")), { guard: { space: ["config_checker"] } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/reject", async (c) => {
      const b = await body(c, RejectSourceVersionBody);
      return rejectVersion(c.ctx, idParam(c.params.sourceId, "source"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: ["config_checker"] } })
    .put("/v1/spaces/:spaceId/sources/:sourceId/shares/:toSpaceId", ({ ctx, params }) =>
      shareSource(ctx, idParam(params.sourceId, "source"), idParam(params.toSpaceId, "space")), { guard: { space: ["space_admin"] } })
    .delete("/v1/spaces/:spaceId/sources/:sourceId/shares/:toSpaceId", async ({ ctx, params }) => {
      await unshareSource(ctx, idParam(params.sourceId, "source"), idParam(params.toSpaceId, "space"));
      return { ok: true };
    }, { guard: { space: ["space_admin"] } });
