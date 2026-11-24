// The recon dashboard (GET /v1/dashboard/recon; docs/superpowers/plans/2026-11-24-recon-dashboard.md "Number
// definitions"). Scope: the spaces the viewer holds a role in (a Superadmin every space, DEC-051), read under one
// withSpace over them; per-space live numbers through the lists' own functions (breakSummary, openBreakdown under the
// Unmatch list's filter), so a number and the list it opens agree. Period numbers from recon_day_stats (stats.ts);
// posting runs and approval requests live (one row per run or request, few).
import { REQUEST_KINDS } from "@starterkit/shared/approvals";
import type { BreakListQuery } from "@starterkit/shared/contracts/breaks";
import { RECON_DASHBOARD_DAYS, type ReconDashboardDto, type ReconDashboardQuery } from "@starterkit/shared/contracts/dashboard";
import { AGE_GROUPS, CLOSED_PARTS, median, POSTING_FAILED, POSTING_FINISHED, RESOLVED_STATUSES } from "@starterkit/shared/dashboard";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SourceKind } from "@starterkit/shared/sources";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { errorDetail, notFound } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { countN } from "../../kernel/pagination";
import { approvalRequests } from "../approvals";
import type { Ctx } from "../auth";
import { deliveryCounts, type DeliverySource, todayIn } from "../ingest";
import { actionRuns } from "../integrations";
import { reconConfigs, reconConfigVersions, reconSourceUses } from "../recon";
import { sources, sourceVersions } from "../sources";
import { viewerSpaces, withSpace } from "../spaces";
import { breakSummary, openBreakdown } from "./break-queue";
import { reconDayStats, reconRuns } from "./schema";
import { closeMoment } from "./rules";
import { addDays } from "./service";
import { missingDays, queueDay } from "./stats";

type Amounts = ReconDashboardDto["open"]["amounts"];
type Results = Record<string, [number, number]>;
const DAY_MS = 86_400_000;
/** Spaces whose live numbers are read at once. ponytail: batches of 4, a pool-wide limiter if reads elsewhere need it. */
const LIVE_SPACES = 4;
/** The start of business date `d` (Asia/Jakarta midnight) as a timestamp. */
const dayStart = (d: string, plus = 0) => sql`((${d}::date + ${plus}::int)::timestamp at time zone 'Asia/Jakarta')`;
/** Timestamp `col` within business dates `from`..`to`: compared raw against their Asia/Jakarta midnights (index-friendly, M4). */
const within = (col: unknown, from: string, to: string) => sql`(${col} >= ${dayStart(from)} and ${col} < ${dayStart(to, 1)})`;

/** Amounts added per currency (never across), the most items first, then the larger amount, then the code (breakSummary's order). */
function addAmounts(...lists: { currency: string | null; amountMinor: string | null; items: number }[][]): Amounts {
  const by = new Map<string, { sum: bigint; items: number }>();
  for (const l of lists) for (const a of l) {
    if (!a.currency || a.amountMinor === null) continue;
    const x = by.get(a.currency) ?? { sum: 0n, items: 0 };
    by.set(a.currency, { sum: x.sum + BigInt(a.amountMinor), items: x.items + a.items });
  }
  return [...by].map(([currency, x]) => ({ currency, amountMinor: String(x.sum), items: x.items }))
    .sort((x, y) => y.items - x.items || (BigInt(y.amountMinor) > BigInt(x.amountMinor) ? 1 : BigInt(y.amountMinor) < BigInt(x.amountMinor) ? -1 : 0) || x.currency.localeCompare(y.currency));
}
const woAmounts = (w: unknown) => Object.entries((w ?? {}) as Record<string, [string, number]>).map(([currency, [amountMinor, items]]) => ({ currency, amountMinor, items }));
const records = (r: Results) => Object.values(r).reduce((n, [, x]) => n + x, 0);
const rowsOf = (r: Results, statuses: readonly string[]) => statuses.reduce((n, s) => n + (r[s]?.[0] ?? 0), 0);
const recordsOf = (r: Results, statuses: readonly string[]) => statuses.reduce((n, s) => n + (r[s]?.[1] ?? 0), 0);

/** GET /v1/dashboard/recon. 404 for a `space` or `recon` outside the viewer's scope. */
export async function reconDashboard(ctx: Ctx, q: ReconDashboardQuery, now = new Date()): Promise<ReconDashboardDto> {
  const to = q.to ?? todayIn(now), from = q.from ?? addDays(to, 1 - RECON_DASHBOARD_DAYS);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, 1 - days);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));

  let scope = await viewerSpaces(ctx);
  if (q.space) {
    scope = scope.filter((s) => s.id === q.space);
    if (!scope.length) throw notFound("space");
  }
  const empty: ReconDashboardDto = {
    period: { from, to }, previous: { from: prevFrom, to: prevTo }, spaces: [], recons: [],
    autoRate: { rows: 0, matched: 0, records: 0, prevMatched: 0, prevRecords: 0 }, open: { count: 0, amounts: [], pastCarryOver: 0, broke: 0, prevBroke: 0 },
    resolved: { rows: 0, prevRows: 0, medianMinutes: null }, posting: { posted: 0, finished: 0, failed: 0, prevPosted: 0, prevFinished: 0 },
    approvals: { waiting: 0, oldestAt: null, requested: 0, prevRequested: 0, decided: 0, rejected: 0, medianMinutes: null },
    days: dates.map((date) => ({ date, auto: 0, manual: 0, broke: 0, matched: 0, records: 0 })),
    age: AGE_GROUPS.map((g) => ({ key: g.key, count: 0, amounts: [] })), reasons: [], closed: CLOSED_PARTS.map((p) => ({ key: p.key, rows: 0 })),
    writtenOff: [], bySpace: [], rows: [], computedAt: null, pending: { days: 0, prevDays: 0 },
    sources: { onTime: 0, late: 0, missing: 0, unknown: 0, rows: [] },
  };
  if (!scope.length) return empty;
  const allIds = scope.map((s) => s.id);
  const recons = await withSpace({ spaceIds: allIds, userId: ctx.user.id }, (tx) => tx.select({ id: reconConfigs.id, name: reconConfigs.name, spaceId: reconConfigs.spaceId })
    .from(reconConfigs).where(inArray(reconConfigs.spaceId, allIds)).orderBy(sql`lower(${reconConfigs.name})`, reconConfigs.id));
  const spaceList = scope.map((s) => ({ id: s.id, name: s.name }));
  if (q.recon) {
    const r = recons.find((x) => x.id === q.recon);
    if (!r) throw notFound("recon");
    scope = scope.filter((s) => s.id === r.spaceId);
  }
  const ids = scope.map((s) => s.id);
  const shown = q.recon ? recons.filter((r) => r.id === q.recon) : recons;
  const cfg = <C extends SQL | unknown>(col: C) => (q.recon ? sql`${col} = ${q.recon}` : undefined);

  // the period's rollup, posting runs, approval requests and last runs: one scope over the spaces
  const period = await withSpace({ spaceIds: ids, userId: ctx.user.id }, async (tx) => {
    const stats = await tx.select().from(reconDayStats)
      .where(and(inArray(reconDayStats.spaceId, ids), cfg(reconDayStats.configId), gte(reconDayStats.businessDate, prevFrom), lte(reconDayStats.businessDate, to)));
    const runAt = sql`coalesce(${actionRuns.finishedAt}, ${actionRuns.createdAt})`;
    const postings = await tx.select({ configId: reconConfigVersions.configId, cur: sql<boolean>`${runAt} >= ${dayStart(from)}`, status: actionRuns.status, n: countN }).from(actionRuns)
      .innerJoin(reconConfigVersions, and(eq(reconConfigVersions.spaceId, actionRuns.spaceId), eq(reconConfigVersions.id, actionRuns.configVersionId)))
      .where(and(inArray(actionRuns.spaceId, ids), eq(actionRuns.kind, "posting"), inArray(actionRuns.status, [...POSTING_FINISHED]), within(runAt, prevFrom, to), cfg(reconConfigVersions.configId)))
      .groupBy(reconConfigVersions.configId, sql`2`, actionRuns.status);
    const ar = approvalRequests;
    const [asked] = await tx.select({
      cur: sql<number>`count(*) filter (where ${within(ar.requestedAt, from, to)})::int`,
      prev: sql<number>`count(*) filter (where ${within(ar.requestedAt, prevFrom, prevTo)})::int`,
    }).from(ar).where(and(inArray(ar.spaceId, ids), cfg(ar.configId), within(ar.requestedAt, prevFrom, to)));
    const decided = await tx.select({ status: ar.status, m: sql<number>`extract(epoch from ${ar.decidedAt} - ${ar.requestedAt}) / 60` }).from(ar)
      .where(and(inArray(ar.spaceId, ids), cfg(ar.configId), inArray(ar.status, ["approved", "rejected"]), within(ar.decidedAt, from, to)));
    // waiting: the inbox's break requests of the space, every recon (the inbox has no recon filter)
    const [waiting] = await tx.select({ n: countN, oldest: sql<Date | null>`min(${ar.requestedAt})` }).from(ar)
      .where(and(inArray(ar.spaceId, ids), eq(ar.status, "pending"), inArray(ar.kind, [...REQUEST_KINDS])));
    const r = reconRuns;
    const lastRuns = await tx.selectDistinctOn([r.configId], { configId: r.configId, status: r.status, at: r.startedAt }).from(r)
      .where(and(inArray(r.spaceId, ids), cfg(r.configId), ne(r.mode, "simulation"), isNull(r.baselineOf))).orderBy(r.configId, desc(r.startedAt));
    // dates with results whose row isn't written yet: their numbers aren't final (C2)
    const gaps = await missingDays(tx, ids, q.recon ?? null, prevFrom, to);
    return { stats, postings, asked: asked!, decided, waiting: waiting!, lastRuns, gaps, delivery: await sourceDeliveries(tx, ids, q.recon ?? null, from, to, now) };
  });
  // and their jobs, due now (keyed: one already queued takes it); a failure here never fails the read
  for (const g of period.gaps) await queueDay(g.spaceId, g.configId, g.date, undefined, 0).catch((e: unknown) => log.warn({ err: errorDetail(e) }, "dashboard: rollup of a missing date not queued"));
  const gapDays = (cur: boolean) => new Set(period.gaps.filter((g) => (g.date >= from) === cur).map((g) => g.date)).size;

  // live per space: the Unmatch list's summary and its breakdown under the same filter
  const filter = { page: 1, pageSize: 15, ...(q.recon ? { recon: [q.recon] } : {}) } as BreakListQuery;
  // LIVE_SPACES at a time: each space holds two of the API pool's connections while it reads (M5)
  const live: { s: (typeof scope)[number]; summary: Awaited<ReturnType<typeof breakSummary>>; groups: Awaited<ReturnType<typeof openBreakdown>> }[] = [];
  for (let i = 0; i < scope.length; i += LIVE_SPACES) {
    live.push(...await Promise.all(scope.slice(i, i + LIVE_SPACES).map(async (s) => {
      const c = { ...ctx, space: { id: s.id, roles: s.roles } };
      const [summary, groups] = await Promise.all([breakSummary(c, filter, now), openBreakdown(c, filter, now)]);
      return { s, summary, groups };
    })));
  }
  const groups = live.flatMap((l) => l.groups.map((g) => ({ ...g, amount: { currency: g.ccy, amountMinor: g.sum, items: g.n } })));

  // the rollup per config, current period and previous
  const cur = period.stats.filter((x) => x.businessDate >= from), prev = period.stats.filter((x) => x.businessDate < from);
  const R = (x: { results: unknown }) => x.results as Results;
  const sum = (xs: typeof cur, f: (x: (typeof cur)[number]) => number) => xs.reduce((n, x) => n + f(x), 0);
  const MATCHED = ["matched"];
  const postingOf = (rows: typeof period.postings, statuses: readonly string[]) => rows.filter((p) => statuses.includes(p.status)).reduce((n, p) => n + p.n, 0);
  const pc = period.postings.filter((p) => p.cur), pp = period.postings.filter((p) => !p.cur);
  const reasons = new Map<string, number>();
  for (const g of groups) if (g.reason) reasons.set(g.reason, (reasons.get(g.reason) ?? 0) + g.n);
  const computed = period.stats.filter((x) => x.businessDate >= from).map((x) => x.computedAt.getTime());

  return {
    ...empty,
    spaces: spaceList,
    recons: recons.map((r) => ({ id: r.id, name: r.name, spaceId: r.spaceId })),
    autoRate: { rows: sum(cur, (x) => rowsOf(R(x), MATCHED)), matched: sum(cur, (x) => recordsOf(R(x), MATCHED)), records: sum(cur, (x) => records(R(x))), prevMatched: sum(prev, (x) => recordsOf(R(x), MATCHED)), prevRecords: sum(prev, (x) => records(R(x))) },
    open: {
      count: live.reduce((n, l) => n + l.summary.open, 0), amounts: addAmounts(...live.map((l) => l.summary.amounts)),
      pastCarryOver: live.reduce((n, l) => n + l.summary.pastCarryOver, 0), broke: sum(cur, (x) => x.broke), prevBroke: sum(prev, (x) => x.broke),
    },
    resolved: { rows: sum(cur, (x) => rowsOf(R(x), RESOLVED_STATUSES)), prevRows: sum(prev, (x) => rowsOf(R(x), RESOLVED_STATUSES)), medianMinutes: median(cur.flatMap((x) => Array.from(x.resolveMinutes))) /* the driver answers an Int32Array */ },
    posting: {
      posted: postingOf(pc, ["posted"]), finished: postingOf(pc, POSTING_FINISHED), failed: postingOf(pc, POSTING_FAILED),
      prevPosted: postingOf(pp, ["posted"]), prevFinished: postingOf(pp, POSTING_FINISHED),
    },
    approvals: {
      waiting: period.waiting.n, oldestAt: period.waiting.oldest ? new Date(period.waiting.oldest).toISOString() : null,
      requested: period.asked.cur, prevRequested: period.asked.prev, decided: period.decided.length,
      rejected: period.decided.filter((d) => d.status === "rejected").length, medianMinutes: median(period.decided.map((d) => Number(d.m))),
    },
    days: dates.map((date) => {
      const xs = cur.filter((x) => x.businessDate === date);
      return {
        date, auto: sum(xs, (x) => recordsOf(R(x), MATCHED)), manual: sum(xs, (x) => recordsOf(R(x), ["matched_by_hand", "force_matched"])),
        broke: sum(xs, (x) => x.broke), matched: sum(xs, (x) => recordsOf(R(x), MATCHED)), records: sum(xs, (x) => records(R(x))),
      };
    }),
    age: AGE_GROUPS.map((g) => {
      const gs = groups.filter((x) => x.age && (g.buckets as readonly string[]).includes(x.age));
      return { key: g.key, count: gs.reduce((n, x) => n + x.n, 0), amounts: addAmounts(gs.map((x) => x.amount)) };
    }),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason)),
    closed: CLOSED_PARTS.map((p) => ({ key: p.key, rows: sum(cur, (x) => rowsOf(R(x), p.statuses)) })),
    writtenOff: addAmounts(...cur.map((x) => woAmounts(x.writtenOff))),
    bySpace: live.map(({ s, summary }) => {
      const xs = cur.filter((x) => x.spaceId === s.id);
      return { id: s.id, name: s.name, open: summary.open, amounts: summary.amounts, matched: sum(xs, (x) => recordsOf(R(x), MATCHED)), records: sum(xs, (x) => records(R(x))), writtenOff: addAmounts(...xs.map((x) => woAmounts(x.writtenOff))) };
    }).sort((x, y) => x.name.localeCompare(y.name)),
    rows: shown.filter((r) => ids.includes(r.spaceId)).map((r) => {
      const xs = cur.filter((x) => x.configId === r.id), gs = groups.filter((g) => g.configId === r.id), run = period.lastRuns.find((x) => x.configId === r.id);
      return {
        id: r.id, name: r.name, spaceId: r.spaceId, spaceName: scope.find((s) => s.id === r.spaceId)!.name,
        records: sum(xs, (x) => records(R(x))), matched: sum(xs, (x) => recordsOf(R(x), MATCHED)),
        open: gs.reduce((n, g) => n + g.n, 0), amounts: addAmounts(gs.map((g) => g.amount)),
        oldest: gs.reduce<string | null>((d, g) => (d === null || g.oldest < d ? g.oldest : d), null),
        postingFailed: postingOf(pc.filter((p) => p.configId === r.id), POSTING_FAILED),
        lastRun: run ? { status: run.status as "queued" | "running" | "succeeded" | "failed", at: run.at.toISOString() } : null,
      };
    }),
    computedAt: computed.length ? new Date(Math.min(...computed)).toISOString() : null,
    pending: { days: gapDays(true), prevDays: gapDays(false) },
    sources: (() => {
      const rows = period.delivery.map((x) => ({ ...x, spaceName: scope.find((s) => s.id === x.spaceId)!.name }));
      const total = (k: "onTime" | "late" | "missing" | "unknown") => rows.reduce((n, r) => n + r[k], 0);
      return { onTime: total("onTime"), late: total("late"), missing: total("missing"), unknown: total("unknown"), rows };
    })(),
  };
}

/**
 * The sources of spaces `ids` (their own and those their recons read; with `recon`, the ones it reads) with their
 * deliveries of `from`..`to` (ingest deliveryCounts). A source with no rule of its own is due when the earliest of
 * the published recons reading it closes the date anyway: close + grace_minutes (breaks.ts closeDay). `spaceId` = its
 * own space when in `ids`, else that of a recon there reading it (a shared source opens under that space).
 */
async function sourceDeliveries(tx: InTx, ids: string[], recon: string | null, from: string, to: string, now: Date) {
  const uses = await tx.selectDistinct({ spaceId: reconSourceUses.spaceId, configId: reconSourceUses.configId, sourceId: reconSourceUses.sourceId }).from(reconSourceUses)
    .where(and(inArray(reconSourceUses.spaceId, ids), recon ? eq(reconSourceUses.configId, recon) : undefined));
  const published = and(eq(sourceVersions.spaceId, sources.spaceId), eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.status, "published"));
  const usedIds = [...new Set(uses.map((u) => u.sourceId))];
  const list = await tx.select({ id: sources.id, spaceId: sources.spaceId, name: sources.name, kind: sources.kind, createdAt: sources.createdAt, spec: sourceVersions.spec })
    .from(sources).innerJoin(sourceVersions, published)
    .where(recon ? (usedIds.length ? inArray(sources.id, usedIds) : sql`false`) : or(inArray(sources.spaceId, ids), usedIds.length ? inArray(sources.id, usedIds) : undefined))
    .orderBy(sql`lower(${sources.name})`, sources.id);
  if (!list.length) return [];
  // every published recon reading them that this scope reads (for the due time), not only the filtered one
  const readers = await tx.selectDistinct({ sourceId: reconSourceUses.sourceId, spec: reconConfigVersions.spec }).from(reconSourceUses)
    .innerJoin(reconConfigVersions, and(eq(reconConfigVersions.spaceId, reconSourceUses.spaceId), eq(reconConfigVersions.configId, reconSourceUses.configId), eq(reconConfigVersions.status, "published")))
    .where(inArray(reconSourceUses.sourceId, list.map((x) => x.id)));
  const reconDue = (sourceId: string, d: string) => readers.filter((r) => r.sourceId === sourceId).reduce<Date | null>((at, r) => {
    const spec = r.spec as ReconSpec;
    const due = new Date(closeMoment(spec, d).getTime() + spec.grace_minutes * 60_000);
    return at === null || due < at ? due : at;
  }, null);
  const counted = await deliveryCounts(tx, list.map((x): DeliverySource => ({ id: x.id, spaceId: x.spaceId, kind: x.kind as SourceKind, spec: x.spec as SourceSpec, createdAt: x.createdAt })), from, to, now, reconDue);
  return list.flatMap((x) => {
    const c = counted.get(x.id);
    if (!c) return [];
    const spaceId = ids.includes(x.spaceId) ? x.spaceId : uses.find((u) => u.sourceId === x.id)!.spaceId;
    return [{ id: x.id, name: x.name, spaceId, ...c }];
  });
}
