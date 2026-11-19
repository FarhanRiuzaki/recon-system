// /v1/spaces/:spaceId/sources/:sourceId/{files,snapshots,quarantine,run}: what a source's ingest did, and a run now.
// Any role reads (files and snapshots also of a source shared to the space; the quarantine of its own sources only);
// source_admin runs one of the space's own sources. Query 400 → guard 401/403 → body 400 → 404 → rules → change →
// activity (the last four in service.ts).
import { Elysia } from "elysia";
import { IngestListQuery, RunSourceBody } from "@starterkit/shared/contracts/sources";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { filePage, quarantinePage, runSourceNow, snapshotPage } from "./service";

export const ingestController = () =>
  new Elysia()
    .use(guard)
    /** Files the inbox picked up, newest first. */
    .get("/v1/spaces/:spaceId/sources/:sourceId/files", ({ ctx, params, query }) =>
      filePage(ctx, idParam(params.sourceId, "source"), query), { query: IngestListQuery, guard: { space: SPACE_ROLES } })
    /** Snapshots per business date, newest date first. */
    .get("/v1/spaces/:spaceId/sources/:sourceId/snapshots", ({ ctx, params, query }) =>
      snapshotPage(ctx, idParam(params.sourceId, "source"), query), { query: IngestListQuery, guard: { space: SPACE_ROLES } })
    /** Quarantined lines, newest first. */
    .get("/v1/spaces/:spaceId/sources/:sourceId/quarantine", ({ ctx, params, query }) =>
      quarantinePage(ctx, idParam(params.sourceId, "source"), query), { query: IngestListQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/sources/:sourceId/run", async (c) => {
      const b = await body(c, RunSourceBody);
      return runSourceNow(c.ctx, idParam(c.params.sourceId, "source"), b);
    }, { guard: { space: ["source_admin"] } });
