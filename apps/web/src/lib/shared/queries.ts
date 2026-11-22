// What a screen reads first, as query keys and API URLs: the browser hooks (features/*) and the server prefetch
// (lib/server/prefetch.tsx) both build their keys here, so a server-prefetched query is exactly the one the hook asks
// for and the browser never fetches it again. Pure (no React, no zod).
// Key scheme: the first element is the module that owns the data (users, rbac, me, audit, dashboard, projects, spaces, sources,
// ingest), then what
// identifies the read (a table's URL, "detail" + id, …), so invalidating a module's key refreshes all of it.
import { isTimeExpression, resolveTimeRange } from "@starterkit/ui/lib/time-range";
import { ACTIVITY_ID_PATTERN } from "@starterkit/shared/audit-investigation";
import { ACTION_OPTIONS, ACTIVITY_SORTS, AUDIT_RANGES, AUTH_LOG_SORTS, presetRange, rangeProblem } from "@starterkit/shared/audit";
import { APPROVAL_SORTS, BREAK_SORTS, PERMISSION_SORTS, PROJECT_SORTS, ROLE_SORTS, RECON_RUN_ITEM_SORTS, RECON_SORTS, RECON_VERSION_SORTS, SOURCE_SORTS, SOURCE_VERSION_SORTS, SPACE_MEMBER_SORTS, SESSION_SORTS, USER_SORTS } from "@starterkit/shared/paging";
import { SOURCE_STATE_FILTERS, type SourceStateFilter } from "@starterkit/shared/sources";
import { MODULES } from "@starterkit/shared/permissions";
import { BREAK_REASONS, ITEM_STATUSES, PASSES_MAX, SIM_CHANGES } from "@starterkit/shared/recon";
import { timeRange } from "./time-controls";
import { type FilterParser, isoDate, multiChoice, oneOf, type TableSpec, type TableState, text } from "./table-state";

/** A server-driven table: query-key prefix, API path, URL state spec, and (optionally) URL filters → API params. */
export type TableDef<F extends Record<string, string>> = {
  key: string; path: `/api/${string}`; spec: TableSpec<F>; transient?: readonly string[]; rawFilters?: readonly string[]; params?: (filters: F) => Record<string, string>;
  edit?: (source: URLSearchParams, patch: Partial<TableState<F>>) => URLSearchParams | null;
};
export type NoFilters = Record<never, string>;

export const DASHBOARD_KEY = ["dashboard"] as const;
export function dashboardRead(sp: Pick<URLSearchParams, "get">) {
  if (!sp.get("range") && !sp.get("from") && !sp.get("to") && !sp.get("start") && !sp.get("end")) return { key: DASHBOARD_KEY, path: "/api/dashboard" };
  const { params } = timeRange(sp);
  const path = `/api/dashboard?${new URLSearchParams(params)}`;
  return { key: [...DASHBOARD_KEY, path], path };
}

/** The signed-in user; own sessions live under the same prefix, so one invalidation refreshes both. */
export const ME_KEY = ["me"] as const;
export const SESSIONS_SPEC: TableSpec<NoFilters> = { sorts: SESSION_SORTS, defaultSort: "-lastSeenAt", filters: {} };
export const MY_SESSIONS: TableDef<NoFilters> = { key: ME_KEY[0], path: "/api/me/sessions", spec: SESSIONS_SPEC };
/** The signed-in user's saved views of list page `path` (at most 20, so one page of 25 holds them all). */
export const savedViews = (path: string) => ({ key: [...ME_KEY, "views", path] as const, url: `/api/me/views?${new URLSearchParams({ path, pageSize: "25" })}` });

export const USERS_KEY = ["users"] as const;
export const USER_STATUSES = ["", "active", "inactive"] as const;
export type UserFilters = { q: string; role: string; status: string };
export const USERS: TableDef<UserFilters> = {
  key: USERS_KEY[0], path: "/api/users",
  spec: { sorts: USER_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200), role: multiChoice(), status: multiChoice() } },
};
export const userDetail = (id: string) => ({ key: [...USERS_KEY, "detail", id] as const, url: `/api/users/${encodeURIComponent(id)}` });
export const userSessions = (id: string): TableDef<NoFilters> => ({ key: USERS_KEY[0], path: `/api/users/${encodeURIComponent(id)}/sessions`, spec: SESSIONS_SPEC });
/** Role pickers ask for one page of 100 (name A–Z), or the roles matching `q`. */
export const roleOptions = (q = "", page = 1) => ({
  key: [...USERS_KEY, "roles", q, ...(page === 1 ? [] : [page])] as const, url: `/api/users/roles?${new URLSearchParams({ pageSize: "100", ...(q ? { q } : {}), ...(page === 1 ? {} : { page: String(page) }) })}`,
});
/** Active Superadmins, to know whether one is the last (it can't be deactivated or deleted). */
export const SUPERADMINS = { key: [...USERS_KEY, "superadmins"] as const, url: "/api/users?role=Superadmin&status=active" };

export const RBAC_KEY = ["rbac"] as const;
export const roleUrl = (id: string) => `/api/roles/${encodeURIComponent(id)}`;
export const roleKey = (id: string) => [...RBAC_KEY, "role", id] as const;
export const ROLES: TableDef<{ q: string }> = {
  key: RBAC_KEY[0], path: "/api/roles", spec: { sorts: ROLE_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200) } },
};
export const PERMISSION_MODULES = ["", ...MODULES.map((m) => m.key)];
export const PERMISSIONS_TABLE: TableDef<{ q: string; module: string }> = {
  key: RBAC_KEY[0], path: "/api/permissions",
  spec: { sorts: PERMISSION_SORTS, defaultSort: "module", search: ["q"], filters: { q: text(200), module: multiChoice() } },
};

export const PROJECTS_KEY = ["projects"] as const;
export const PROJECT_STATUSES = ["", "active", "archived"] as const;
export type ProjectFilters = { q: string; status: string };
export const PROJECTS: TableDef<ProjectFilters> = {
  key: PROJECTS_KEY[0], path: "/api/projects",
  spec: { sorts: PROJECT_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200), status: multiChoice() } },
};
export const projectDetail = (id: string) => ({ key: [...PROJECTS_KEY, "detail", id] as const, url: `/api/projects/${encodeURIComponent(id)}` });

export const SPACES_KEY = ["spaces"] as const;
/** The switcher's list: all the caller's spaces, not the URL state of any table. */
export const spaceOptions = () => ({ key: [...SPACES_KEY, "options"] as const, url: "/api/spaces?pageSize=100" });
export const spaceDetail = (id: string) => ({ key: [...SPACES_KEY, "detail", id] as const, url: `/api/spaces/${encodeURIComponent(id)}` });
/** One spec object for every space (useTableQuery memoizes on it); `q` matches the name or the username. */
const SPACE_MEMBERS_SPEC: TableSpec<{ q: string }> = { sorts: SPACE_MEMBER_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200) } };
export const SPACE_MEMBERS = (id: string): TableDef<{ q: string }> => ({ key: SPACES_KEY[0], path: `/api/spaces/${encodeURIComponent(id)}/members`, spec: SPACE_MEMBERS_SPEC });
/** The spaces a user is in, with their roles there (user detail's Spaces panel): one page of 100, name A–Z. */
export const userSpaces = (userId: string) => ({
  key: [...SPACES_KEY, "user", userId] as const, url: `/api/users/${encodeURIComponent(userId)}/spaces?pageSize=100`,
});
/** Add-member picker: one page of 100 users (name A–Z), or those matching `q`, each flagged when already a member. */
export const spaceCandidates = (id: string, q = "") => ({
  key: [...SPACES_KEY, "candidates", id, q] as const,
  url: `/api/spaces/${encodeURIComponent(id)}/candidates?${new URLSearchParams({ pageSize: "100", ...(q ? { q } : {}) })}`,
});

export const SOURCES_KEY = ["sources"] as const;
export type SourceFilters = { q: string; state: "" | SourceStateFilter };
const SOURCES_SPEC: TableSpec<SourceFilters> = { sorts: SOURCE_SORTS, defaultSort: "name", search: ["q"], filters: { q: text(200), state: oneOf(["", ...SOURCE_STATE_FILTERS], "") } };
const sourcesPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/sources` as const;
/** A space's sources and those shared to it; `q` matches the code or the name, `state` keeps one summary state. */
export const SOURCES = (spaceId: string): TableDef<SourceFilters> => ({ key: SOURCES_KEY[0], path: sourcesPath(spaceId), spec: SOURCES_SPEC });
/** How many of them are in each state (the list's summary tiles). */
export const sourceSummary = (spaceId: string) => ({ key: [...SOURCES_KEY, "summary", spaceId] as const, url: `${sourcesPath(spaceId)}/summary` });
export const sourceDetail = (spaceId: string, id: string) => ({
  key: [...SOURCES_KEY, "detail", spaceId, id] as const, url: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}`,
});
/**
 * What a source's ingest did (the ingest module's routes), newest first: the API takes no sort, so the spec has none.
 * `tab` stays when the table pages (the source detail's tabs live in the URL).
 */
export const INGEST_KEY = ["ingest"] as const;
const INGEST_SPEC: TableSpec<NoFilters> = { sorts: [], defaultSort: "", filters: {} };
// the quarantine shares the Records tab with the records list: its own paging keys (qr.page)
const QUARANTINE_SPEC: TableSpec<NoFilters> = { ...INGEST_SPEC, ns: "qr" };
const ingestTable = (what: "files" | "snapshots" | "quarantine") => (spaceId: string, id: string): TableDef<NoFilters> =>
  ({ key: INGEST_KEY[0], path: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/${what}`, spec: what === "quarantine" ? QUARANTINE_SPEC : INGEST_SPEC, transient: ["tab"] });
export const sourceFiles = ingestTable("files");
export const sourceSnapshots = ingestTable("snapshots");
export const sourceQuarantine = ingestTable("quarantine");
/** A watermark source's newest pulls, the Pull history card's first page (older pages load as it scrolls). */
export const PULL_PAGE = 25;
export const sourcePullsFirst = (spaceId: string, id: string) => ({
  key: [INGEST_KEY[0], "pulls", spaceId, id, "first"] as const, url: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/pulls?page=1&pageSize=${PULL_PAGE}`,
});
/** A source's current records (the Records tab): `q` the start of a reference or account, `businessDate` one date. */
export type RecordFilters = { q: string; businessDate: string };
const RECORDS_SPEC: TableSpec<RecordFilters> = { sorts: [], defaultSort: "", search: ["q"], filters: { q: text(200), businessDate: isoDate } };
export const sourceRecords = (spaceId: string, id: string): TableDef<RecordFilters> =>
  ({ key: INGEST_KEY[0], path: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/records`, spec: RECORDS_SPEC, transient: ["tab"] });
/** A source's versions, newest first (`tab` stays when the table pages). */
const SOURCE_VERSIONS_SPEC: TableSpec<NoFilters> = { sorts: SOURCE_VERSION_SORTS, defaultSort: "-version", filters: {}, ns: "v" };
export const sourceVersions = (spaceId: string, id: string): TableDef<NoFilters> =>
  ({ key: SOURCES_KEY[0], path: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/versions`, spec: SOURCE_VERSIONS_SPEC, transient: ["tab"] });
/** A source's own activity (read through the sources module), newest first; the API takes no sort. */
export const sourceActivity = (spaceId: string, id: string): TableDef<TrailFilters> =>
  ({ key: SOURCES_KEY[0], path: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/activity`, spec: TRAIL_SPEC, params: auditParams, transient: ["tab"] });
/** One version of a source, with the names of the people it names. */
export const sourceVersion = (spaceId: string, id: string, versionId: string) => ({
  key: [...SOURCES_KEY, "version", spaceId, id, versionId] as const,
  url: `${sourcesPath(spaceId)}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
});

export const RECON_KEY = ["recon"] as const;
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
  ({ key: RECON_KEY[0], path: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/activity`, spec: TRAIL_SPEC, params: auditParams, transient: ["tab"] });
/** One version of a recon, with the names of the people it names. */
export const reconVersion = (spaceId: string, id: string, versionId: string) => ({
  key: [...RECON_KEY, "version", spaceId, id, versionId] as const,
  url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
});
/** Runs of a recon belong to the engine module. */
export type BreakFilters = { q: string; recon: string; reason: string; state: string; age: string; assignee: string };
const BREAKS_SPEC: TableSpec<BreakFilters> = {
  sorts: BREAK_SORTS, defaultSort: "businessDate", search: ["q"],
  filters: { q: text(200), recon: text(36), reason: multiChoice(), state: multiChoice(), age: multiChoice(), assignee: multiChoice() },
};
/** One value of a multi-choice filter when exactly one is ticked (the API takes one), else none. */
const single = (v: string) => { const x = v.split(",").filter(Boolean); return x.length === 1 ? x[0]! : ""; };
/**
 * A space's breaks queue (the engine's, Plan 5), oldest business date first: `reason`, `state`, `age` and `assignee`
 * (me, none = Unassigned) reach the API when one is ticked; `recon` one recon (a link from it); `q` the reference.
 */
export const BREAKS = (spaceId: string): TableDef<BreakFilters> => ({
  key: ENGINE_KEY[0], path: `/api/spaces/${encodeURIComponent(spaceId)}/breaks`, spec: BREAKS_SPEC,
  params: ({ reason, state, age, assignee, ...rest }) => ({ ...rest, reason: single(reason), state: single(state), age: single(age), assignee: single(assignee) }),
});

const breakPath = (spaceId: string, id: string) => `/api/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(id)}` as const;
/** One break: its item, recon, state, resolution, proposed pair. */
export const breakDetail = (spaceId: string, id: string) => ({ key: [...ENGINE_KEY, "break", spaceId, id] as const, url: breakPath(spaceId, id) });
const CANDIDATES_SPEC: TableSpec<{ q: string }> = { sorts: [], defaultSort: "", search: ["q"], filters: { q: text(200) }, ns: "c" };
/** The other side's items free to match a break, nearest amount first (its page's "Find a counterpart"; c.page). */
export const breakCandidates = (spaceId: string, id: string): TableDef<{ q: string }> => ({ key: ENGINE_KEY[0], path: `${breakPath(spaceId, id)}/candidates`, spec: CANDIDATES_SPEC });
/** A break's own trail, newest first (a.page beside the candidates). */
export const breakActivity = (spaceId: string, id: string): TableDef<TrailFilters> => ({ key: ENGINE_KEY[0], path: `${breakPath(spaceId, id)}/activity`, spec: TRAIL_SPEC, params: auditParams });

export const APPROVALS_KEY = ["approvals"] as const;
export type ApprovalFilters = { q: string; kind: string; mine: string };
const APPROVALS_SPEC: TableSpec<ApprovalFilters> = { sorts: APPROVAL_SORTS, defaultSort: "submittedAt", search: ["q"], filters: { q: text(200), kind: multiChoice(), mine: oneOf(["", "1"], "") } };
/**
 * A space's approvals inbox, waiting longest first; `kind` picks one kind (both ticked, or none, = every kind), `q`
 * matches the source's or recon's code or name, `mine` = only what the viewer may decide. Deciding a version invalidates APPROVALS_KEY.
 */
export const APPROVALS = (spaceId: string): TableDef<ApprovalFilters> => ({
  key: APPROVALS_KEY[0], path: `/api/spaces/${encodeURIComponent(spaceId)}/approvals`, spec: APPROVALS_SPEC,
  params: ({ kind, mine, ...rest }) => { const k = kind.split(",").filter(Boolean); return { ...rest, ...(k.length === 1 ? { kind: k[0]! } : {}), ...(mine ? { mine } : {}) }; },
});

export const ENGINE_KEY = ["engine"] as const;
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
/** Live day: one recon's current day, polled as Today. */
export const reconLive = (spaceId: string, id: string) => ({
  key: [...ENGINE_KEY, "live", spaceId, id] as const, url: `${reconsPath(spaceId)}/${encodeURIComponent(id)}/live` as const,
});
/**
 * How often Today and Live day read again while the tab is visible (plan 4 decision 2: a snapshot per read instead of
 * SSE; a day's numbers move once per run, at most every minute).
 */
export const LIVE_POLL_MS = 15_000;
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
export const sideSourceOptions = (spaceId: string) => ({ key: [...SOURCES_KEY, "options", spaceId] as const, url: `${sourcesPath(spaceId)}?pageSize=100` });

export const AUDIT_KEY = ["audit"] as const;
/** Entry identity is independent of list state; only validated, normalized UUIDs become BFF paths. */
export const activityEntry = (id: string) => ({
  key: [...AUDIT_KEY, "entry", id.toLowerCase()] as const,
  url: ACTIVITY_ID_PATTERN.test(id) ? `/api/audit/activity/${id.toLowerCase()}` as const : null,
});


/** Filters both audit logs share: who (free text, debounced) and the range: a preset, or a custom from–to pair that wins when valid. */
export type AuditFilters = { user: string; range: (typeof AUDIT_RANGES)[number]; from: string; to: string; start: string; end: string };
const timeExpression: FilterParser<string> = raw => raw && isTimeExpression(raw) ? raw : "";
const AUDIT_FILTERS = { start: timeExpression, end: timeExpression, user: text(64), range: oneOf(AUDIT_RANGES, "7d"), from: isoDate, to: isoDate } satisfies { [K in keyof AuditFilters]: FilterParser<AuditFilters[K]> };
export const customRange = (f: { from: string; to: string }) => (f.from && f.to && rangeProblem(f.from, f.to) === null ? { from: f.from, to: f.to } : null);
/** API parameters: a valid custom from–to, else the preset as from/to calendar dates (app time zone, today included). */
const auditParams = ({ range, from, to, start, end, ...rest }: Omit<AuditFilters, "user"> & Record<string, string>) =>
  ({ ...rest, ...(resolveTimeRange({ start, end }, Date.now()) ? { start, end } : customRange({ from, to }) ?? presetRange(range, Date.now())) });

/**
 * A record's own trail (a source's, a recon's Activity tab): the header's range as the logs read it (start–end, from–to
 * or a preset), the last 90 days by default (owner, 22 Nov: the header's date filter on every module with dated rows; a
 * week would hide most of a config's history).
 */
export type TrailFilters = Omit<AuditFilters, "user">;
const TRAIL_SPEC: TableSpec<TrailFilters> = { sorts: [], defaultSort: "", ns: "a", filters: { start: timeExpression, end: timeExpression, range: oneOf(AUDIT_RANGES, "90d"), from: isoDate, to: isoDate } };
/** The default range of a trail, for the header's label. */
export const TRAIL_DAYS = 90;

export type ActivityFilters = AuditFilters & { action: string; actorId: string; targetType: string; targetId: string };
const exact: FilterParser<string> = raw => raw ?? "";
export const ACTIONS = [{ value: "", label: "Any" }, ...ACTION_OPTIONS];
export const ACTIVITY: TableDef<ActivityFilters> = {
  key: AUDIT_KEY[0], path: "/api/audit/activity", params: auditParams, transient: ["entry"], rawFilters: ["actorId", "targetType", "targetId"],
  spec: { sorts: ACTIVITY_SORTS, defaultSort: "-at", search: ["user"], filters: { ...AUDIT_FILTERS, action: multiChoice(), actorId: exact, targetType: exact, targetId: exact } },
};
export type AuthLogFilters = AuditFilters & { event: string; method: string };
export const AUTH_LOG: TableDef<AuthLogFilters> = {
  key: AUDIT_KEY[0], path: "/api/audit/auth", params: auditParams,
  spec: {
    sorts: AUTH_LOG_SORTS, defaultSort: "-at", search: ["user"],
    filters: { ...AUDIT_FILTERS, event: multiChoice(), method: multiChoice() },
  },
};
