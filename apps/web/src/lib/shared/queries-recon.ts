// Reads of the recon side (recon, engine, approvals, breaks): apart from queries.ts so the pages that don't show them
// (the users, audit and source screens, every route's shell) don't carry them in their first load (bundle budget,
// DEC-040). Keys still start with the owning module (queries.test.ts reads both files); the module keys themselves
// (RECON_KEY, ENGINE_KEY, APPROVALS_KEY) stay in queries.ts, so any screen invalidates them.
import { APPROVAL_SORTS, BREAK_SORTS, RECON_RUN_ITEM_SORTS, RECON_SORTS, RECON_VERSION_SORTS, SIGNOFF_SORTS, WORKFLOW_SORTS } from "@starterkit/shared/paging";
import { BREAK_REASONS, ITEM_STATUSES, PASSES_MAX, SIM_CHANGES } from "@starterkit/shared/recon";
import { APPROVALS_KEY, ENGINE_KEY, type NoFilters, RECON_KEY, type TableDef, trailTable, type TrailFilters } from "./queries";
import { isoDate, multiChoice, oneOf, readTable, tableRequest, type TableSpec, text } from "./table-state";

const RECONS_SPEC: TableSpec<{ q: string }> = { sorts: RECON_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200) } };
const reconsPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/recons` as const;
/** A space's recons; `q` matches the code or the name. */
export const RECONS = (spaceId: string): TableDef<{ q: string }> => ({ key: RECON_KEY[0], path: reconsPath(spaceId), spec: RECONS_SPEC });
export const reconDetail = (spaceId: string, id: string) => ({
  key: [...RECON_KEY, "detail", spaceId, id] as const, url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}`,
});
/** A recon's versions, newest first (`tab` stays when the table pages). */
const RECON_VERSIONS_SPEC: TableSpec<NoFilters> = { sorts: RECON_VERSION_SORTS, defaultSort: "-version", filters: {}, ns: "v" };
export const reconVersions = (spaceId: string, id: string): TableDef<NoFilters> =>
  ({ key: RECON_KEY[0], path: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/versions`, spec: RECON_VERSIONS_SPEC, transient: ["tab"] });
/** A recon's own activity, newest first; the API takes no sort. */
export const reconActivity = (spaceId: string, id: string): TableDef<TrailFilters> =>
  trailTable(RECON_KEY[0], `${reconsPath(spaceId)}/${encodeURIComponent(id)}/activity`, ["tab"]);
/** One version of a recon, with the names of the people it names. */
export const reconVersion = (spaceId: string, id: string, versionId: string) => ({
  key: [...RECON_KEY, "version", spaceId, id, versionId] as const,
  url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
});
/** Runs of a recon belong to the engine module. */
export type SignoffFilters = { stage: string };
const SIGNOFF_SPEC: TableSpec<SignoffFilters> = { sorts: SIGNOFF_SORTS, defaultSort: "-date", filters: { stage: oneOf(["", "closed", "prepared", "signed"], "") }, ns: "s" };
/** A recon's closed days and their sign-off (Plan 5 Task 4), newest first; its own paging keys (s.page) on the Overview. */
export const reconSignoffs = (spaceId: string, id: string): TableDef<SignoffFilters> =>
  ({ key: ENGINE_KEY[0], path: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/signoffs`, spec: SIGNOFF_SPEC, transient: ["tab"] });
export type BreakFilters = { q: string; recon: string; reason: string; state: string; age: string; assignee: string };
const BREAKS_SPEC: TableSpec<BreakFilters> = {
  sorts: BREAK_SORTS, defaultSort: "-amount", search: ["q"],
  filters: { q: text(200), recon: text(36), reason: multiChoice(), state: multiChoice(), age: multiChoice(), assignee: multiChoice() },
};
/**
 * A space's breaks queue (the engine's, Plan 5), largest amount first: `reason`, `state`, `age` and `assignee`
 * (me, none = Unassigned) with every ticked value; `recon` one recon (a link from it); `q` the reference; with counts.
 */
export const BREAKS = (spaceId: string): TableDef<BreakFilters> => ({
  key: ENGINE_KEY[0], path: `/api/spaces/${encodeURIComponent(spaceId)}/breaks`, spec: BREAKS_SPEC,
  facets: true,
});
/** The queue's headline numbers under the list's filters (`filterQuery` of useTableQuery), keyed beside its rows. */
export const breakSummaryUrl = (spaceId: string, filterQuery: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/breaks/summary${filterQuery ? `?${filterQuery}` : ""}`;
/** One recon's open unmatch totals (its Overview's open amount, audit R3): the queue's summary for that recon. */
export const reconOpenSummary = (spaceId: string, configId: string) => {
  const url = breakSummaryUrl(spaceId, new URLSearchParams({ recon: configId }).toString());
  return { key: [ENGINE_KEY[0], url] as const, url };
};
/** One recon's open unmatch per reason (its Overview's Unmatch by reason, audit R2): the queue's filter counts for that recon. */
export const reconReasons = (spaceId: string, configId: string) => {
  const url = `/api/spaces/${encodeURIComponent(spaceId)}/breaks/facets?${new URLSearchParams({ recon: configId })}`;
  return { key: [ENGINE_KEY[0], url] as const, url };
};

const breakPath = (spaceId: string, id: string) => `/api/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(id)}` as const;
/** One break: its item, recon, state, resolution, proposed pair. */
export const breakDetail = (spaceId: string, id: string) => ({ key: [...ENGINE_KEY, "break", spaceId, id] as const, url: breakPath(spaceId, id) });
const CANDIDATES_SPEC: TableSpec<{ q: string }> = { sorts: [], defaultSort: "", search: ["q"], filters: { q: text(200) }, ns: "c" };
/** The other side's items free to match a break, nearest amount first (its page's "Find a counterpart"; c.page). */
export const breakCandidates = (spaceId: string, id: string): TableDef<{ q: string }> => ({ key: ENGINE_KEY[0], path: `${breakPath(spaceId, id)}/candidates`, spec: CANDIDATES_SPEC });
/** A break's own trail, newest first (a.page beside the candidates). */
export const breakActivity = (spaceId: string, id: string): TableDef<TrailFilters> => trailTable(ENGINE_KEY[0], `${breakPath(spaceId, id)}/activity`);

export type ApprovalFilters = { q: string; kind: string; mine: string };
const mineOf = oneOf(["1", "0"], "1");
/** `mine` 1 or 0; an empty one is a link or saved view from when every request was the default (mine=), so 0. */
const mineFilter = (raw: string | null) => (raw === "" ? "0" : mineOf(raw));
const APPROVALS_SPEC: TableSpec<ApprovalFilters> = { sorts: APPROVAL_SORTS, defaultSort: "submittedAt", search: ["q"], filters: { q: text(200), kind: multiChoice(), mine: mineFilter } };
/**
 * A space's approvals inbox, waiting longest first; `kind` the ticked kinds (none = every kind), `q`
 * matches the source's or recon's code or name, `mine` 1 (the default, audit §5.2) = only what the viewer may decide,
 * 0 = every request (the API's `mine` left out). Deciding a version invalidates APPROVALS_KEY.
 */
export const APPROVALS = (spaceId: string): TableDef<ApprovalFilters> => ({
  key: APPROVALS_KEY[0], path: `/api/spaces/${encodeURIComponent(spaceId)}/approvals`, spec: APPROVALS_SPEC,
  facets: true, params: (f) => ({ q: f.q, kind: f.kind, mine: f.mine === "1" ? "1" : "" }),
});

/** The first page of the approvals inbox as it opens (Waiting for me): Today's count of what waits for the viewer, under the inbox's own key. */
export const myApprovals = (spaceId: string) => {
  const d = APPROVALS(spaceId);
  const { url } = tableRequest(d.path, readTable(new URLSearchParams(), d.spec), d.spec, d.params);
  return { key: [d.key, url] as const, url };
};

const runsPath = (spaceId: string, id: string) => `${reconsPath(spaceId)}/${encodeURIComponent(id)}/runs` as const;
/** A draft's simulations, newest first: the first row is the one the builder shows. */
export const draftSimulations = (spaceId: string, id: string, versionId: string) => ({
  key: [...ENGINE_KEY, "simulations", spaceId, id, versionId] as const,
  url: `${runsPath(spaceId, id)}?${new URLSearchParams({ mode: "simulation", versionId })}`,
});
/**
 * The pairs a draft's simulation changes against the published version (spec §10: what a checker reviews), by business
 * date; `change` keeps one kind. The version page's own params (`from`) stay when the table pages.
 */
const SIM_CHANGES_SPEC: TableSpec<{ change: string }> = { sorts: [], defaultSort: "", filters: { change: oneOf(["", ...SIM_CHANGES], "") } };
export const reconSimChanges = (spaceId: string, id: string, runId: string): TableDef<{ change: string }> =>
  ({ key: ENGINE_KEY[0], path: `${runsPath(spaceId, id)}/${encodeURIComponent(runId)}/changes`, spec: SIM_CHANGES_SPEC, transient: ["from"] });
/** One run of a recon (polled while it is queued or running). */
export const reconRun = (spaceId: string, id: string, runId: string) => ({
  key: [...ENGINE_KEY, "run", spaceId, id, runId] as const, url: `${runsPath(spaceId, id)}/${encodeURIComponent(runId)}`,
});
/** Today (REC-F4): the space's recons' current days and their sources; the screens read it again every LIVE_POLL_MS. */
export const spaceToday = (spaceId: string) => ({
  key: [...ENGINE_KEY, "today", spaceId] as const, url: `/api/spaces/${encodeURIComponent(spaceId)}/today` as const,
});
/** A recon's last TREND_DAYS business dates (its Overview's chart), read again with its day. */
export const reconTrend = (spaceId: string, id: string) => ({
  key: [...ENGINE_KEY, "trend", spaceId, id] as const, url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/days` as const,
});
/** The first page of a recon's runs, newest first (its Run history; older pages load as the list scrolls). */
export const RUN_PAGE = 15;
export const reconRunsFirst = (spaceId: string, id: string) => ({
  key: [...ENGINE_KEY, "runs-first", spaceId, id] as const, url: `${runsPath(spaceId, id)}?${new URLSearchParams({ pageSize: String(RUN_PAGE) })}`,
});
/** A recon's newest scheduled interval runs (mode tick, newest first): the Run card's next run counts from the first. */
export const reconLastTick = (spaceId: string, id: string) => ({
  key: [...ENGINE_KEY, "runs-tick", spaceId, id] as const, url: `${runsPath(spaceId, id)}?${new URLSearchParams({ mode: "tick", pageSize: String(RUN_PAGE) })}`,
});
/** Live day: one recon's current day, polled as Today. */
export const reconLive = (spaceId: string, id: string) => ({
  key: [...ENGINE_KEY, "live", spaceId, id] as const, url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/live` as const,
});
/**
 * How often Today and Live day read again while the tab is visible (plan 4 decision 2: a snapshot per read instead of
 * SSE; a day's numbers move once per run, at most every minute).
 */
export const LIVE_POLL_MS = 15_000;
/**
 * How often Today reads "Waiting for my approval" again: the inbox's Waiting for me checks each pending request's chain
 * (up to 500 per read, API INBOX_REQUESTS_MAX), so it is not read on every live poll.
 */
export const MY_APPROVALS_POLL_MS = 60_000;
/** While a run of the recon (or of one of the space's) is queued or under way: its numbers move with every step. */
export const LIVE_RUN_POLL_MS = 5_000;
export type RunItemFilters = { pass: string; status: string; side: string; date: string; reason: string };
const RUN_ITEMS_SPEC: TableSpec<RunItemFilters> = {
  sorts: RECON_RUN_ITEM_SORTS, defaultSort: "businessDate",
  filters: {
    pass: oneOf(["", ...Array.from({ length: PASSES_MAX }, (_, i) => String(i + 1))], ""), status: oneOf(["", ...ITEM_STATUSES], ""),
    side: oneOf(["", "a", "b"], ""), date: isoDate, reason: oneOf(["", ...BREAK_REASONS], ""),
  },
};
type PassLike = { accept: string; cardinality: string };
/**
 * A run's items as its results tabs ask for them: a pass tab (`pass`, the first when no tab is chosen) shows its pairs,
 * one row per group from the group's single side (`status` matched or suggested, the pass's own by default), or the
 * items it broke (`status` break with its `pass`, both sides); the Waiting tab is `status` open, the Breaks tab `status`
 * break without a pass. `date` = the day the strip picked.
 * `passes` = the run version's passes (their accept and cardinality decide the defaults).
 */
export const reconRunItems = (spaceId: string, id: string, runId: string, passes: readonly PassLike[] = []): TableDef<RunItemFilters> => ({
  key: ENGINE_KEY[0], path: `${runsPath(spaceId, id)}/${encodeURIComponent(runId)}/items`, spec: RUN_ITEMS_SPEC,
  params: (f) => {
    // Waiting (open) and Breaks (break, every pass and day close, the run's own dates, a reason) are tabs without a pass
    if (f.status === "open" && !f.pass) return { ...f, reason: "" };
    if (f.status === "break" && !f.pass) return { ...f, own: "1" };
    const pass = f.pass || "1", p = passes[Number(pass) - 1];
    const status = f.status || (p?.accept === "suggest" ? "suggested" : "matched");
    return { ...f, pass, status, reason: "", side: status === "break" ? f.side : p?.cardinality === "N:1" ? "b" : "a" };
  },
});
/** The sources a side may read (this space's and those shared to it), at most 100: the new recon's side pickers. */

const workflowsPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/workflows` as const;
export type LibraryFilters = { q: string };
/** A space's workflows (DEC-052 rev 2), by name; `q` matches the name. */
export const WORKFLOWS = (spaceId: string): TableDef<LibraryFilters> => ({
  key: APPROVALS_KEY[0], path: workflowsPath(spaceId), spec: { sorts: WORKFLOW_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200) } },
});
/** The connectors' published operations a recon's action may pick (stage 4), read by any role of the space. */
export const connectorOperationsQuery = (spaceId: string) =>
  ({ key: [...APPROVALS_KEY, "connector-operations", spaceId] as const, url: `/api/spaces/${encodeURIComponent(spaceId)}/connector-operations` as const });
/** A recon's breaks to preview an action with (first 25, oldest first). */
export const reconBreaksQuery = (spaceId: string, configId: string) =>
  ({ key: [...APPROVALS_KEY, "preview-breaks", spaceId, configId] as const, url: `/api/spaces/${encodeURIComponent(spaceId)}/breaks?recon=${encodeURIComponent(configId)}&pageSize=25` as const });
/** The space's workflows a recon may pick (first 100 by name), for the setup's Approval step. */
export const workflowOptions = (spaceId: string) =>
  ({ key: [...APPROVALS_KEY, "workflow-options", spaceId] as const, url: `${workflowsPath(spaceId)}?pageSize=100&sort=name` as const });
/** One workflow of a space: its live and open version, the role names and people it may name. */
export const spaceWorkflow = (spaceId: string, id: string) =>
  ({ key: [...APPROVALS_KEY, "workflow", spaceId, id] as const, url: `${workflowsPath(spaceId)}/${encodeURIComponent(id)}` as const });
/** The recon versions of the space that pin a workflow (u.page beside its editor). */
export const usedByTable = (spaceId: string, id: string): TableDef<Record<string, never>> => ({
  key: APPROVALS_KEY[0], path: `${workflowsPath(spaceId)}/${encodeURIComponent(id)}/used-by`, spec: { sorts: [], defaultSort: "", filters: {}, ns: "u" },
});

