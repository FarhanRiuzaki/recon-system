// /v1/spaces/:spaceId/sources*: every route takes the space guard without `or` (a platform admin has no data access),
// so in an archived space each change is 409 space_archived. Roles (spec §11, Plan 2): any role reads; source_admin
// creates a source, sets, tests and reads its connection; source_admin or config_maker drafts, edits and submits a version
// (and a config_checker previews one it reviews);
// config_checker approves or rejects one someone else made; space_admin shares; any role of the owning space reads the
// source's activity (any role reads the versions; through a share the published and retired ones). Query 400 → guard 401/403 → body 400 →
// 404 → rules → change → activity (the last four in service.ts).
import { Elysia } from "elysia";
import {
  CreateSourceBody, IngestListQuery, NewSourceTestBody, PreviewSourceBody, QueryColumnsBody, RejectSourceVersionBody, SetConnectionBody, SourceCatalogBody, SourceColumnsQuery,
  SourceListQuery, SourceVersionListQuery, TestConnectionBody, UpdateSourceVersionBody,
} from "@starterkit/shared/contracts/sources";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import {
  approveVersion, createDraft, createSource, discardSource, previewVersion, queryColumns, refusedSpec, rejectVersion, setConnection, shareSource, sourceActivity, sourceColumns, sourceDetail,
  sourceCatalog, sourcePage, sourceSummary, submitVersion, testConnection, testNewSource, unshareSource, updateVersion, versionDetail, versionPage,
} from "./service";

const MAKERS = ["source_admin", "config_maker"] as const;

/** The routes of /v1/spaces/:spaceId/sources*. */
export const sourcesController = () =>
  new Elysia()
    .use(guard)
    /** The space's sources and those shared to it. */
    .get("/v1/spaces/:spaceId/sources", ({ ctx, query }) => sourcePage(ctx, query), { query: SourceListQuery, guard: { space: SPACE_ROLES } })
    /** How many of them are healthy, need attention, are paused or are drafts (the list's summary tiles). */
    .get("/v1/spaces/:spaceId/sources/summary", ({ ctx }) => sourceSummary(ctx), { guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/sources", async (c) => {
      const s = await createSource(c.ctx, await body(c, CreateSourceBody));
      c.set.status = 201;
      return s;
    }, { guard: { space: ["source_admin"] } })
    /** A new source's typed folder or connection, tried before the source exists; nothing is stored. */
    .post("/v1/spaces/:spaceId/sources/connection-test", async (c) => testNewSource(c.ctx, await body(c, NewSourceTestBody)), { guard: { space: ["source_admin"] } })
    /** What a new source's typed connection can read (databases, tables, a table's columns); nothing is stored. */
    .post("/v1/spaces/:spaceId/sources/catalog", async (c) => sourceCatalog(c.ctx, null, await body(c, SourceCatalogBody)), { guard: { space: ["source_admin"] } })
    .get("/v1/spaces/:spaceId/sources/:sourceId", ({ ctx, params }) => sourceDetail(ctx, idParam(params.sourceId, "source")), { guard: { space: SPACE_ROLES } })
    /** A draft source never submitted nor shared, deleted with its connection and draft. */
    .delete("/v1/spaces/:spaceId/sources/:sourceId", async ({ ctx, params }) => {
      await discardSource(ctx, idParam(params.sourceId, "source"));
      return { ok: true };
    }, { guard: { space: ["source_admin"] } })
    .put("/v1/spaces/:spaceId/sources/:sourceId/connection", async (c) => {
      const b = await body(c, SetConnectionBody);
      return setConnection(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } })
    /** Connects with the stored credential (or reads the file inbox folder); changes nothing. */
    .post("/v1/spaces/:spaceId/sources/:sourceId/connection/test", async (c) => {
      const b = await body(c, TestConnectionBody);
      return testConnection(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } })
    /** What the stored (or a typed) connection can read: databases, tables, a table's columns; changes nothing. */
    .post("/v1/spaces/:spaceId/sources/:sourceId/connection/catalog", async (c) => {
      const b = await body(c, SourceCatalogBody);
      return sourceCatalog(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } })
    /** The columns of one table of the source database. */
    .get("/v1/spaces/:spaceId/sources/:sourceId/connection/columns", ({ ctx, params, query }) =>
      sourceColumns(ctx, idParam(params.sourceId, "source"), query.table), { query: SourceColumnsQuery, guard: { space: ["source_admin"] } })
    /** The result columns of a SELECT (a read sent as POST for its body). */
    .post("/v1/spaces/:spaceId/sources/:sourceId/connection/columns", async (c) => {
      const b = await body(c, QueryColumnsBody);
      return queryColumns(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } })
    /** The source's own activity: its creation, connection, every version step and share. */
    .get("/v1/spaces/:spaceId/sources/:sourceId/activity", ({ ctx, params, query }) =>
      sourceActivity(ctx, idParam(params.sourceId, "source"), query), { query: IngestListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/sources/:sourceId/versions", ({ ctx, params, query }) =>
      versionPage(ctx, idParam(params.sourceId, "source"), query), { query: SourceVersionListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId", ({ ctx, params }) =>
      versionDetail(ctx, idParam(params.sourceId, "source"), idParam(params.versionId, "version")), { guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions", async (c) => {
      const v = await createDraft(c.ctx, idParam(c.params.sourceId, "source"));
      c.set.status = 201;
      return v;
    }, { guard: { space: MAKERS } })
    .patch("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId", async (c) => {
      const b = await body(c, UpdateSourceVersionBody).catch(refusedSpec);
      return updateVersion(c.ctx, idParam(c.params.sourceId, "source"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: MAKERS } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/versions/:versionId/preview", async (c) => {
      const b = await body(c, PreviewSourceBody).catch(refusedSpec);
      return previewVersion(c.ctx, idParam(c.params.sourceId, "source"), idParam(c.params.versionId, "version"), b);
    }, { guard: { space: [...MAKERS, "config_checker"] } })
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
