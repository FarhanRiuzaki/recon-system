// /v1/spaces/:spaceId/recons/:configId/runs* and …/versions/:versionId/simulate: runs and simulations of a recon;
// /v1/spaces/:spaceId/today and …/recons/:configId/live: the recons' current days (today.ts). Every
// route takes the space guard without `or` (a platform admin has no data access). Roles (Plan 3 Task 3): an operator or
// a config maker runs the published version; a config maker simulates a draft (and becomes its contributor); any role
// reads; a space admin rolls a run back with every live run after it (rollback.ts). A request answers 202 with the run,
// queued; the worker runs it (jobs.ts). Query 400 → guard 401/403 → body
// 400 → 404 → rules → change → activity (the last four in jobs.ts and service.ts).
import { Elysia } from "elysia";
import { AssignBreaksBody, BreakCandidateQuery, BreakListQuery, BreakStateBody, CloseBreakBody, MatchBreakBody, RequestBreakBody, TakeBreaksBody } from "@starterkit/shared/contracts/breaks";
import { TargetActivityQuery } from "@starterkit/shared/contracts/audit";
import { ReconRunItemQuery, ReconRunListQuery, ReconSimChangeQuery, RunRangeBody, SignoffBody, SignoffListQuery } from "@starterkit/shared/contracts/recon";
import { ResultListQuery, ResultMembersQuery } from "@starterkit/shared/contracts/results";
import { SPACE_ACTION, SPACE_ROLES } from "@starterkit/shared/spaces";
import { body, idParam } from "../../kernel/parse";
import { guard } from "../auth";
import { assignBreaks, breakFacets, breakPage, breakSummary, setBreakState, takeBreaks } from "./break-queue";
import { breakActivity, breakDetail, candidatePage, closeBreak, matchBreak, matchPair } from "./break-resolve";
import { requestChange } from "./break-requests";
import { signoffPage, signoffStep } from "./signoff";
import { discardDraftVersion, requestRollback, requestRun, requestSimulation } from "./jobs";
import { runDetail, runItemPage, runPage, simChangePage } from "./service";
import { reconLive, reconTrend, todayDto } from "./today";
import { navCounts } from "./nav-counts";
import { resultCounts, resultMembers, resultPage } from "./results";

/** The routes of runs and simulations. */
export const engineController = () =>
  new Elysia()
    .use(guard)
    /** Today (REC-F4): the space's recons' current business dates and the sources they read. */
    .get("/v1/spaces/:spaceId/today", ({ ctx }) => todayDto(ctx), { guard: { space: SPACE_ROLES } })
    /** The sidebar's counts: open unmatch, what waits for the caller, postings needing attention. */
    .get("/v1/spaces/:spaceId/nav-counts", ({ ctx }) => navCounts(ctx), { guard: { space: SPACE_ROLES } })
    // the breaks queue (Plan 5): any role reads it; a space admin or reviewer assigns; whoever works breaks takes them
    .get("/v1/spaces/:spaceId/breaks", ({ ctx, query }) => breakPage(ctx, query), { query: BreakListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/breaks/facets", ({ ctx, query }) => breakFacets(ctx, query), { query: BreakListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/breaks/summary", ({ ctx, query }) => breakSummary(ctx, query), { query: BreakListQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/breaks/assign", async (c) => assignBreaks(c.ctx, await body(c, AssignBreaksBody)), { guard: { space: SPACE_ACTION.assign } })
    .post("/v1/spaces/:spaceId/breaks/take", async (c) => takeBreaks(c.ctx, await body(c, TakeBreaksBody)), { guard: { space: SPACE_ACTION.work } })
    .post("/v1/spaces/:spaceId/breaks/state", async (c) => setBreakState(c.ctx, await body(c, BreakStateBody)), { guard: { space: SPACE_ACTION.work } })
    // one break: its page, the other side's free items, its trail; resolving it (whoever has it, or a lead)
    .get("/v1/spaces/:spaceId/breaks/:itemId", ({ ctx, params }) => breakDetail(ctx, idParam(params.itemId, "unmatch item")), { guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/breaks/:itemId/candidates", ({ ctx, params, query }) => candidatePage(ctx, idParam(params.itemId, "unmatch item"), query), { query: BreakCandidateQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/breaks/:itemId/activity", ({ ctx, params, query }) => breakActivity(ctx, idParam(params.itemId, "unmatch item"), query), { query: TargetActivityQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/breaks/:itemId/match", async (c) => {
      const b = await body(c, MatchBreakBody);
      return matchBreak(c.ctx, idParam(c.params.itemId, "unmatch item"), b);
    }, { guard: { space: SPACE_ACTION.work } })
    .post("/v1/spaces/:spaceId/breaks/:itemId/match-pair", ({ ctx, params }) => matchPair(ctx, idParam(params.itemId, "unmatch item")), { guard: { space: SPACE_ACTION.work } })
    .post("/v1/spaces/:spaceId/breaks/:itemId/close", async (c) => {
      const b = await body(c, CloseBreakBody);
      return closeBreak(c.ctx, idParam(c.params.itemId, "unmatch item"), b);
    }, { guard: { space: SPACE_ACTION.work } })
    // a change a checker decides (force match, unmatch, write-off): asked by whoever works the break, decided by a lead
    .post("/v1/spaces/:spaceId/breaks/:itemId/request", async (c) => {
      const b = await body(c, RequestBreakBody);
      return requestChange(c.ctx, idParam(c.params.itemId, "unmatch item"), b);
    }, { guard: { space: SPACE_ACTION.work } })
    // a recon's closed days and their sign-off (Task 4): any role reads; a reviewer or space admin prepares, another signs
    .get("/v1/spaces/:spaceId/recons/:configId/signoffs", ({ ctx, params, query }) => signoffPage(ctx, idParam(params.configId, "recon"), query), { query: SignoffListQuery, guard: { space: SPACE_ROLES } })
    .post("/v1/spaces/:spaceId/recons/:configId/signoffs/prepare", async (c) => {
      const b = await body(c, SignoffBody);
      return signoffStep(c.ctx, idParam(c.params.configId, "recon"), b, "prepare");
    }, { guard: { space: SPACE_ACTION.signOff } })
    .post("/v1/spaces/:spaceId/recons/:configId/signoffs/sign", async (c) => {
      const b = await body(c, SignoffBody);
      return signoffStep(c.ctx, idParam(c.params.configId, "recon"), b, "sign");
    }, { guard: { space: SPACE_ACTION.signOff } })
    // Operation result: one recon's results in a business-date range (groups and lone items), any role reads
    .get("/v1/spaces/:spaceId/recons/:configId/results", ({ ctx, params, query }) => resultPage(ctx, idParam(params.configId, "recon"), query), { query: ResultListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/results/counts", ({ ctx, params, query }) => resultCounts(ctx, idParam(params.configId, "recon"), query), { query: ResultListQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/results/:rowId/members", ({ ctx, params, query }) =>
      resultMembers(ctx, idParam(params.configId, "recon"), idParam(params.rowId, "result"), query), { query: ResultMembersQuery, guard: { space: SPACE_ROLES } })
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
    }, { guard: { space: SPACE_ACTION.runRecon } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId", ({ ctx, params }) => runDetail(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run")), { guard: { space: SPACE_ROLES } })
    /** A run and every live run after it rolled back, then their dates run again: the rerun, queued (rollback.ts). */
    .post("/v1/spaces/:spaceId/recons/:configId/runs/:runId/rollback", async (c) => {
      const r = await requestRollback(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.runId, "run"));
      c.set.status = 202;
      return r;
    }, { guard: { space: SPACE_ACTION.rollbackRun } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId/items", ({ ctx, params, query }) =>
      runItemPage(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run"), query), { query: ReconRunItemQuery, guard: { space: SPACE_ROLES } })
    .get("/v1/spaces/:spaceId/recons/:configId/runs/:runId/changes", ({ ctx, params, query }) =>
      simChangePage(ctx, idParam(params.configId, "recon"), idParam(params.runId, "run"), query), { query: ReconSimChangeQuery, guard: { space: SPACE_ROLES } })
    /** Discards a recon's open draft (the published version keeps running): its simulations, then the draft. */
    .delete("/v1/spaces/:spaceId/recons/:configId/versions/:versionId", async ({ ctx, params, set }) => {
      await discardDraftVersion(ctx, idParam(params.configId, "recon"), idParam(params.versionId, "version"));
      set.status = 204;
    }, { guard: { space: SPACE_ACTION.editRecon } })
    /** A simulation of a draft over business dates, queued; its job also simulates the published version and compares. */
    .post("/v1/spaces/:spaceId/recons/:configId/versions/:versionId/simulate", async (c) => {
      const b = await body(c, RunRangeBody);
      const r = await requestSimulation(c.ctx, idParam(c.params.configId, "recon"), idParam(c.params.versionId, "version"), b);
      c.set.status = 202;
      return r;
    }, { guard: { space: SPACE_ACTION.simulate } });
