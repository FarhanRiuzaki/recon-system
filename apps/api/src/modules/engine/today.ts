// Today and Live day (REC-F4, spec §9 "Freshness", §11a): each active recon's current business date as its last live
// run left it, its day state, freshness and open breaks, and the sources it reads. The day's numbers are that run's
// RunDay (recon_runs.days, written when it finalized, again after a close): a screen read never counts items (S1: ~18M
// a side a day), so the numbers move once per run, as §11a's "animates once per tick". A handful of queries for every
// recon of the space at once, all under the viewer's withSpace (RLS).
import { postingAttention } from "../integrations";
import { type LiveReconDto, ReconSpec, type ReconLiveDto, type ReconTrendDto, RunDay, type TodayDto } from "@starterkit/shared/contracts/recon";
import { TODAY_RECONS_MAX, TREND_DAYS } from "@starterkit/shared/recon";
import { and, count, desc, eq, inArray, isNotNull, isNull, max, min, ne, or, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import type { Ctx } from "../auth";
import { todayIn } from "../ingest";
import { reconConfigs, reconConfigVersions } from "../recon";
import { liveSources } from "../sources";
import { withSpace } from "../spaces";
import { lastDue, staleNow } from "./rules";
import { reconAlerts, reconDays, reconItems, reconRuns } from "./schema";

const SCHEDULED = ["tick", "daily"];

/** GET …/today: the space's active recons with a published version, by name (at most TODAY_RECONS_MAX), and their sources. */
export function todayDto(ctx: Ctx, now = new Date()): Promise<TodayDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const all = await liveRecons(tx, spaceId, null, now);
    const recons = all.slice(0, TODAY_RECONS_MAX);
    const ids = [...new Set(recons.flatMap((r) => r.sides.map((s) => s.sourceId)))];
    return { recons, sources: await liveSources(tx, spaceId, ids), capped: all.length > TODAY_RECONS_MAX, posting: await postingAttention(tx, spaceId, now) };
  });
}

/** GET …/recons/:configId/live: one recon's current business date and its sources; 409 before its first approval. */
export function reconLive(ctx: Ctx, configId: string, now = new Date()): Promise<ReconLiveDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select({ id: reconConfigs.id }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [recon] = await liveRecons(tx, spaceId, configId, now);
    if (!recon) throw new ApiError("invalid_state", "This recon has no approved version running yet. Its day shows here once a version is approved.");
    return { recon, sources: await liveSources(tx, spaceId, recon.sides.map((s) => s.sourceId)) };
  });
}

/**
 * GET …/recons/:configId/days: the TREND_DAYS business dates up to its current one, each as the last finalized live run
 * covering it left it. One small query a date (recon_runs_config_started), never a count of items. 409 before an
 * approved version.
 */
export function reconTrend(ctx: Ctx, configId: string, now = new Date()): Promise<ReconTrendDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select({ id: reconConfigs.id }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
    if (!v) throw new ApiError("invalid_state", "This recon has no approved version running yet. Its days show here once a version is approved.");
    const spec = ReconSpec.parse(v.spec);
    const last = spec.schedule.kind === "interval" ? todayIn(now) : lastDue(spec, now);
    const dates = Array.from({ length: TREND_DAYS }, (_, i) => new Date(Date.parse(`${last}T00:00:00Z`) - (TREND_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10));
    const r = reconRuns;
    const days = [];
    for (const date of dates) {
      const [run] = await tx.select({ days: r.days }).from(r)
        .where(and(eq(r.spaceId, spaceId), eq(r.configId, configId), ne(r.mode, "simulation"), isNull(r.baselineOf), eq(r.status, "succeeded"), isNotNull(r.days),
          sql`${date}::date between ${r.dateFrom} and ${r.dateTo}`))
        .orderBy(desc(r.finishedAt)).limit(1);
      const stored = Array.isArray(run?.days) ? (run.days as unknown[]).find((d) => (d as { date?: string }).date === date) : undefined;
      const day = stored ? RunDay.safeParse(stored) : null;
      days.push({ date, day: day?.success ? day.data : null });
    }
    return { days };
  });
}

/** The live picture of the space's active recons with a published version (`only`: that one), by name; one past the cap. */
async function liveRecons(tx: InTx, spaceId: string, only: string | null, now: Date): Promise<LiveReconDto[]> {
  const v = reconConfigVersions;
  const pub = await tx.select({ id: reconConfigs.id, name: reconConfigs.name, spec: v.spec }).from(v)
    .innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, v.spaceId), eq(reconConfigs.id, v.configId)))
    .where(and(eq(v.spaceId, spaceId), eq(v.status, "published"), eq(reconConfigs.status, "active"), only ? eq(reconConfigs.id, only) : undefined))
    .orderBy(sql`lower(${reconConfigs.name})`, reconConfigs.id).limit(TODAY_RECONS_MAX + 1);
  if (!pub.length) return [];
  const ids = pub.map((p) => p.id);
  const list = pub.map((p) => {
    const spec = ReconSpec.parse(p.spec);
    return { ...p, spec, date: spec.schedule.kind === "interval" ? todayIn(now) : lastDue(spec, now) };
  });
  const inCfg = <C extends typeof reconRuns.configId | typeof reconDays.configId | typeof reconItems.configId | typeof reconAlerts.configId | typeof v.configId>(col: C) => inArray(col, ids);

  const first = new Map((await tx.select({ id: v.configId, at: min(v.publishedAt) }).from(v)
    .where(and(eq(v.spaceId, spaceId), inCfg(v.configId))).groupBy(v.configId)).map((r) => [r.id, r.at]));
  const days = await tx.select({ id: reconDays.configId, date: reconDays.businessDate, status: reconDays.status }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), inCfg(reconDays.configId), or(...list.map((c) => and(eq(reconDays.configId, c.id), eq(reconDays.businessDate, c.date))))));
  const closed = new Map((await tx.select({ id: reconDays.configId, d: sql<string>`max(${reconDays.businessDate})::text` }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), inCfg(reconDays.configId), eq(reconDays.status, "closed"))).groupBy(reconDays.configId)).map((r) => [r.id, r.d]));
  const r = reconRuns;
  const live = and(eq(r.spaceId, spaceId), inCfg(r.configId), ne(r.mode, "simulation"), isNull(r.baselineOf));
  const success = new Map((await tx.select({ id: r.configId, at: max(r.finishedAt) }).from(r)
    .where(and(live, inArray(r.mode, SCHEDULED), eq(r.status, "succeeded"))).groupBy(r.configId)).map((x) => [x.id, x.at]));
  // the last finalized live run that covered each recon's date (its days hold the date's picture)
  const covered = await tx.selectDistinctOn([r.configId], { id: r.configId, runId: r.id, at: r.finishedAt, days: r.days }).from(r)
    .where(and(live, eq(r.status, "succeeded"), isNotNull(r.days), or(...list.map((c) => and(eq(r.configId, c.id), sql`${c.date}::date between ${r.dateFrom} and ${r.dateTo}`)))))
    .orderBy(r.configId, desc(r.finishedAt));
  const running = await tx.selectDistinctOn([r.configId], { id: r.configId, runId: r.id, status: r.status, at: r.startedAt }).from(r)
    .where(and(live, inArray(r.status, ["queued", "running"]))).orderBy(r.configId, desc(r.startedAt));
  const breaks = new Map((await tx.select({ id: reconItems.configId, n: count() }).from(reconItems)
    .where(and(eq(reconItems.spaceId, spaceId), inCfg(reconItems.configId), eq(reconItems.status, "break"), isNull(reconItems.simRunId))).groupBy(reconItems.configId)).map((x) => [x.id, x.n]));
  const alerts = new Map((await tx.select({ id: reconAlerts.configId, at: reconAlerts.alertedAt }).from(reconAlerts)
    .where(and(eq(reconAlerts.spaceId, spaceId), inCfg(reconAlerts.configId)))).map((x) => [x.id, x.at]));

  return list.map((c): LiveReconDto => {
    const cov = covered.find((x) => x.id === c.id), run = running.find((x) => x.id === c.id);
    const stored = Array.isArray(cov?.days) ? (cov.days as unknown[]).find((d) => (d as { date?: string }).date === c.date) : undefined;
    const day = stored ? RunDay.safeParse(stored) : null;
    const lastSuccess = success.get(c.id) ?? null;
    const since = lastSuccess ?? new Date(`${todayIn(first.get(c.id) ?? now)}T00:00:00+07:00`);
    const state = days.find((d) => d.id === c.id)?.status;
    return {
      id: c.id, name: c.name, schedule: c.spec.schedule, date: c.date,
      sides: [{ label: c.spec.sides[0].label, sourceId: c.spec.sides[0].source_id }, { label: c.spec.sides[1].label, sourceId: c.spec.sides[1].source_id }],
      state: state === "closed" || state === "closing" ? state : "open",
      day: day?.success ? day.data : null, runId: day?.success ? cov!.runId : null, runAt: day?.success ? cov!.at?.toISOString() ?? null : null,
      lastSuccessAt: lastSuccess?.toISOString() ?? null, stale: staleNow(c.spec, since, closed.get(c.id) ?? null, now),
      alertedAt: alerts.get(c.id)?.toISOString() ?? null,
      running: run ? { id: run.runId, status: run.status as "queued" | "running", startedAt: run.at.toISOString() } : null,
      openBreaks: breaks.get(c.id) ?? 0,
    };
  });
}

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
