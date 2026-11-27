// Monitoring (spec §8): per feed and MIS date what arrived, what is late or failed (from import_file_history in staging,
// whoever wrote it: this engine or import-host), and each scheduler's health (from import_runs, the history's PROCESSING
// rows and the latest check). Feeds are few, so every read is bounded by them and by MONITOR_DAYS.
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  ImportCellDto, ImportCheckDto, ImportCheckListQuery, ImportDateDto, ImportFeedSpec, ImportHistoryDto, ImportHistoryListQuery, ImportIssuesDto,
  ImportMonitorDto, ImportMonitorQuery, ImportRunDto, ImportRunListQuery,
} from "@starterkit/shared/contracts/imports";
import { DATE_STATES, type DateState, type HistoryStatus, MONITOR_DAYS } from "@starterkit/shared/imports";
import { appDate, shiftDate } from "@starterkit/ui/lib/format";
import { db } from "../../kernel/db";
import { notFound } from "../../kernel/errors";
import { one, pageQuery, sortSql } from "../../kernel/pagination";
import { users } from "../users";
import { type CheckSeen, dateState, dueOf, type HistoryVersion, schedulerState } from "./rules";
import { importChecks, importFeeds, importHeartbeat, importRuns } from "./schema";
import { history } from "./staging/history-table";
import { staging } from "./staging/pool";
import { BEAT_KEY } from "./worker";

/** A worker whose minute is older than this is down (the beat is every minute). */
const BEAT_STALE_MS = 3 * 60_000;
/** Scheduler states that are an issue (the badge); `ok` and `off` aren't. */
const BAD_SCHEDULER = new Set(["missed", "stuck", "lock_left", "connection_failing"]);
const BAD_CELL = new Set<DateState>(["missing", "failed"]);

type RunRow = typeof importRuns.$inferSelect & { byName: string | null };
const runDto = (r: RunRow): ImportRunDto => ({
  id: r.id, feedId: r.feedId, trigger: r.trigger as ImportRunDto["trigger"], scheduledFor: r.scheduledFor?.toISOString() ?? null,
  startedAt: r.startedAt.toISOString(), heartbeatAt: r.heartbeatAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
  status: r.status as ImportRunDto["status"], dates: r.dates, message: r.message, by: r.userId ? { id: r.userId, name: r.byName ?? "Deleted user" } : null,
});
type CheckRow = typeof importChecks.$inferSelect & { byName: string | null };
const checkDto = (r: CheckRow): ImportCheckDto => ({
  id: r.id, date: r.fileDate, at: r.at.toISOString(), trigger: r.trigger as ImportCheckDto["trigger"], result: r.result as ImportCheckDto["result"],
  rows: r.rows, inserted: r.inserted, replaced: r.replaced, historyId: r.historyId, message: r.message,
  by: r.userId ? { id: r.userId, name: r.byName ?? "Deleted user" } : null,
});
type HistoryRow = ReturnType<typeof history>["$inferSelect"];
const historyDto = (r: HistoryRow): ImportHistoryDto => ({
  id: r.id, fileName: r.fileName, fileDate: r.fileDate, status: r.status as HistoryStatus, fileSize: r.fileSize, fileHash: r.fileHash.trim(),
  totalRows: r.totalRows, insertedRows: r.insertedRows, duplicateInFile: r.duplicateInFile, alreadyInDb: r.alreadyInDb, replacedRows: r.replacedRows,
  previousId: r.previousId, errorMessage: r.errorMessage, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});
const version = (r: Pick<HistoryRow, "status" | "totalRows" | "errorMessage" | "createdAt" | "finishedAt" | "updatedAt">): HistoryVersion => ({
  status: r.status as HistoryStatus, totalRows: r.totalRows, errorMessage: r.errorMessage, createdAt: r.createdAt, finishedAt: r.finishedAt, updatedAt: r.updatedAt,
});
const seen = (c: { at: Date; result: string; message: string | null } | undefined): CheckSeen | null =>
  c ? { at: c.at, result: c.result as CheckSeen["result"], message: c.message } : null;
const cellDto = (date: string, c: ReturnType<typeof dateState>): ImportCellDto => ({ date, state: c.state, rows: c.rows, at: c.at?.toISOString() ?? null, message: c.message });

const runsWithNames = () => db.select({ run: importRuns, byName: users.name }).from(importRuns).leftJoin(users, eq(users.id, importRuns.userId));
const checksWithNames = () => db.select({ check: importChecks, byName: users.name }).from(importChecks).leftJoin(users, eq(users.id, importChecks.userId));

/** Whether the worker's minute is fresh. */
async function workerAlive(now: Date): Promise<boolean> {
  const [b] = await db.select({ at: importHeartbeat.at }).from(importHeartbeat).where(eq(importHeartbeat.key, BEAT_KEY));
  return !!b && now.getTime() - b.at.getTime() < BEAT_STALE_MS;
}

/** GET /v1/imports/monitor: every feed's scheduler and its last MONITOR_DAYS MIS dates up to `to` (default yesterday, WIB). */
export async function monitor(q: ImportMonitorQuery, now = new Date()): Promise<ImportMonitorDto> {
  const feeds = await db.select().from(importFeeds).orderBy(sql`lower(${importFeeds.name})`, importFeeds.id);
  const to = q.to ?? shiftDate(appDate(now.getTime()), -1);
  const dates = Array.from({ length: MONITOR_DAYS }, (_, i) => shiftDate(to, i - (MONITOR_DAYS - 1)));
  const st = staging(); // 409 when staging isn't set up: the page says so
  const h = history();
  const specs = new Map(feeds.map((f) => [f.id, f.spec as ImportFeedSpec]));
  const sources = [...new Set([...specs.values()].map((s) => s.historySource))];
  const ids = feeds.map((f) => f.id);
  const [versions, locks, checks, latest, recent, lastRuns, alive] = await Promise.all([
    sources.length ? st.select().from(h).where(and(inArray(h.source, sources), gte(h.fileDate, dates[0]!), lte(h.fileDate, to))) : [],
    sources.length ? st.select({ source: h.source, fileDate: h.fileDate, updatedAt: h.updatedAt }).from(h).where(and(inArray(h.source, sources), eq(h.status, "PROCESSING"))) : [],
    ids.length ? db.select().from(importChecks).where(and(inArray(importChecks.feedId, ids), gte(importChecks.fileDate, dates[0]!), lte(importChecks.fileDate, to))).orderBy(desc(importChecks.at)) : [],
    ids.length ? db.selectDistinctOn([importChecks.feedId]).from(importChecks).where(inArray(importChecks.feedId, ids)).orderBy(importChecks.feedId, desc(importChecks.at)) : [],
    ids.length ? db.select().from(importRuns).where(and(inArray(importRuns.feedId, ids), or(gte(importRuns.startedAt, new Date(now.getTime() - 26 * 3_600_000)), eq(importRuns.status, "running")))) : [],
    ids.length ? db.selectDistinctOn([importRuns.feedId], { run: importRuns, byName: users.name }).from(importRuns).leftJoin(users, eq(users.id, importRuns.userId))
      .where(inArray(importRuns.feedId, ids)).orderBy(importRuns.feedId, desc(importRuns.startedAt)) : [],
    workerAlive(now),
  ]);
  const today = Object.fromEntries(DATE_STATES.map((s) => [s, 0])) as Record<DateState, number>;
  const out = feeds.map((f) => {
    const spec = specs.get(f.id)!;
    const cells = dates.filter((d) => d >= spec.startDate).map((d) => {
      const c = dateState({
        versions: versions.filter((v) => v.source === spec.historySource && v.fileDate === d).map(version),
        lastCheck: seen(checks.find((c) => c.feedId === f.id && c.fileDate === d)), due: dueOf(d, spec.due), now,
      });
      if (d === to) today[c.state]++;
      return cellDto(d, c);
    });
    const s = schedulerState({
      on: f.schedulerOn, changedAt: f.schedulerChangedAt, times: spec.schedule?.times ?? [], maxMinutes: spec.schedule?.maxMinutes ?? 30,
      runs: recent.filter((r) => r.feedId === f.id).map((r) => ({ status: r.status as ImportRunDto["status"], scheduledFor: r.scheduledFor, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt })),
      locks: locks.filter((l) => l.source === spec.historySource), lastCheck: seen(latest.find((c) => c.feedId === f.id)), now,
    });
    const last = lastRuns.find((r) => r.run.feedId === f.id);
    return {
      id: f.id, name: f.name, schedulerOn: f.schedulerOn, cells,
      scheduler: { state: s.state, message: s.message, nextRun: s.nextRun?.toISOString() ?? null, lastRun: last ? runDto({ ...last.run, byName: last.byName }) : null },
    };
  });
  return { now: now.toISOString(), workerAlive: alive, dates, today, feeds: out };
}

/**
 * GET /v1/imports/issues (the Monitoring badge): Missing and Failed dates over MONITOR_DAYS, schedulers missed, stuck,
 * holding a lock or unable to connect, and one more when the worker is down while some scheduler is on. 0 when staging
 * isn't set up (the pages say that instead).
 */
export async function issues(now = new Date()): Promise<ImportIssuesDto> {
  const m = await monitor({}, now).catch((e: unknown) => {
    if ((e as { code?: string }).code === "invalid_state") return null;
    throw e;
  });
  if (!m) return { count: 0 };
  const cells = m.feeds.reduce((n, f) => n + f.cells.filter((c) => BAD_CELL.has(c.state)).length, 0);
  const schedulers = m.feeds.filter((f) => BAD_SCHEDULER.has(f.scheduler.state)).length;
  return { count: cells + schedulers + (!m.workerAlive && m.feeds.some((f) => f.schedulerOn) ? 1 : 0) };
}

async function feedSpec(id: string): Promise<{ spec: ImportFeedSpec }> {
  const [f] = await db.select({ spec: importFeeds.spec }).from(importFeeds).where(eq(importFeeds.id, id));
  if (!f) throw notFound("import feed");
  return { spec: f.spec as ImportFeedSpec };
}

/** GET /v1/imports/feeds/:id/dates/:date: one cell opened: its state, every check (newest first), every history version. */
export async function feedDate(id: string, date: string, now = new Date()): Promise<ImportDateDto> {
  const { spec } = await feedSpec(id);
  const h = history();
  const [versions, checks] = await Promise.all([
    staging().select().from(h).where(and(eq(h.source, spec.historySource), eq(h.fileDate, date))).orderBy(desc(h.createdAt), desc(h.id)),
    checksWithNames().where(and(eq(importChecks.feedId, id), eq(importChecks.fileDate, date))).orderBy(desc(importChecks.at)),
  ]);
  const c = dateState({ versions: versions.map(version), lastCheck: seen(checks[0]?.check), due: dueOf(date, spec.due), now });
  return { date, state: c.state, checks: checks.map((r) => checkDto({ ...r.check, byName: r.byName })), versions: versions.map(historyDto) };
}

/** GET /v1/imports/feeds/:id/history: the feed's import_file_history rows (staging), newest first by default. */
export async function historyPage(id: string, q: ImportHistoryListQuery): Promise<Page<ImportHistoryDto>> {
  const { spec } = await feedSpec(id);
  const h = history();
  const st = staging();
  const where = and(eq(h.source, spec.historySource), q.date ? eq(h.fileDate, q.date) : undefined, q.status ? eq(h.status, q.status) : undefined);
  return pageQuery({
    rows: st.select().from(h).where(where).$dynamic(),
    count: st.select(one).from(h).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { createdAt: h.createdAt, fileDate: h.fileDate }, "-createdAt", h.id),
    query: q,
    map: historyDto,
    on: st,
  });
}

/** GET /v1/imports/feeds/:id/runs: the feed's runs, newest first by default. */
export async function runPage(id: string, q: ImportRunListQuery): Promise<Page<ImportRunDto>> {
  await feedSpec(id);
  const where = and(eq(importRuns.feedId, id), q.status ? eq(importRuns.status, q.status) : undefined);
  return pageQuery({
    rows: runsWithNames().where(where).$dynamic(),
    count: db.select(one).from(importRuns).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { startedAt: importRuns.startedAt }, "-startedAt", importRuns.id),
    query: q,
    map: (r) => runDto({ ...r.run, byName: r.byName }),
  });
}

/** GET /v1/imports/feeds/:id/checks: the feed's checks, newest first by default; `date` narrows to one MIS date. */
export async function checkPage(id: string, q: ImportCheckListQuery): Promise<Page<ImportCheckDto>> {
  await feedSpec(id);
  const where = and(eq(importChecks.feedId, id), q.date ? eq(importChecks.fileDate, q.date) : undefined);
  return pageQuery({
    rows: checksWithNames().where(where).$dynamic(),
    count: db.select(one).from(importChecks).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { at: importChecks.at }, "-at", importChecks.id),
    query: q,
    map: (r) => checkDto({ ...r.check, byName: r.byName }),
  });
}
