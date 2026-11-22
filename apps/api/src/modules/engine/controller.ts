// /v1/spaces/:spaceId/recons/:configId/runs* and …/versions/:versionId/simulate: runs and simulations of a recon;
// /v1/spaces/:spaceId/today and …/recons/:configId/live: the recons' current days (today.ts). Every
// route takes the space guard without `or` (a platform admin has no data access). Roles (Plan 3 Task 3): an operator or
// a config maker runs the published version; a config maker simulates a draft (and becomes its contributor); any role
// reads. A request answers 202 with the run, queued; the worker runs it (jobs.ts). Query 400 → guard 401/403 → body
// 400 → 404 → rules → change → activity (the last four in jobs.ts and service.ts).
import { Elysia } from "elysia";
import { AssignBreaksBody, BreakListQuery, BreakStateBody, TakeBreaksBody } from "@starterkit/shared/contracts/breaks";
import { ReconRunItemQuery, ReconRunListQuery, ReconSimChangeQuery, RunRangeBody } from "@starterkit/shared/contracts/recon";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { assignBreaks, breakPage, setBreakState, takeBreaks } from "./break-queue";
import { discardDraftVersion, requestRun, requestSimulation } from "./jobs";
import { runDetail, runItemPage, runPage, simChangePage } from "./service";
import { reconLive, reconTrend, todayDto } from "./today";

/** The routes of runs and simulations. */
export const engineController = () =>
  new Elysia()
    .use(guard)
    /** Today (REC-F4): the space's recons' current business dates and the sources they read. */
    .get("/v1/spaces/:spaceId/today", ({ ctx }) => todayDto(ctx), { guard: { space: SPACE_ROLES } })
    // the breaks queue (Plan 5): any role reads it; a space admin or reviewer assigns; whoever works breaks takes them
    .get("/v1/spaces/:spaceId/breaks", ({ ctx, query }) => breakPage(ctx, query), { query: BreakListQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/breaks/assign", async (c) => assignBreaks(c.ctx, await body(c, AssignBreaksBody)), { guard: { space: ["space_admin", "reviewer"] } })
    .post("/v1/spaces/:spaceId/breaks/take", async (c) => takeBreaks(c.ctx, await body(c, TakeBreaksBody)), { guard: { space: ["operator", "reviewer", "space_admin"] } })
    .post("/v1/spaces/:spaceId/breaks/state", async (c) => setBreakState(c.ctx, await body(c, BreakStateBody)), { guard: { space: ["operator", "reviewer", "space_admin"] } })
    /** Live day: one recon's current business date. */
    .get("/v1/spaces/:spaceId/recons/:configId/live", ({ ctx, params }) => reconLive(ctx, idParam(params.configId, "recon")), { guard: { space: SPACE_ROLES } })
    /** A recon's trend: its last TREND_DAYS business dates. */
    .get("/v1/spaces/:spaceId/recons/:configId/days", ({ ctx, params }) => reconTrend(ctx, idParam(params.configId, "recon")), { guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs", ({ ctx, params, query }) => runPage(ctx, idParam(params.configId, "recon"), query), { query: ReconRunListQuery, guard: { space: SPACE_ROLES } })
    /** A run of the published version over business dates, queued. */
    .post("/v1/spaces/:spaceId/recons/:configId/runs", async (c) => {
      const b = await body(c, RunRangeBody);
      const r = await requestRun(c.ctx, idParam(c.params.configId, "recon"), b);
      c.set.status = 202;
      return r;
    }, { guard: { space: ["operator", "config_maker", "space_admin"] } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId", ({ ctx, params }) => runDetail(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run")), { guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId/items", ({ ctx, params, query }) =>
      runItemPage(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run"), query), { query: ReconRunItemQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId/changes", ({ ctx, params, query }) =>
      simChangePage(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run"), query), { query: ReconSimChangeQuery, guard: { space: SPACE_ROLES } })
    /** Discards a recon's open draft (the published version keeps running): its simulations, then the draft. */
    .delete("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", async ({ ctx, params, set }) => {
      await discardDraftVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version"));
      set.status = 204;
    }, { guard: { space: ["config_maker"] } })
    /** A simulation of a draft over business dates, queued; its job also simulates the published version and compares. */
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/simulate", async (c) => {
      const b = await body(c, RunRangeBody);
      const r = await requestSimulation(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
      c.set.status = 202;
      return r;
    }, { guard: { space: ["config_maker"] } });
