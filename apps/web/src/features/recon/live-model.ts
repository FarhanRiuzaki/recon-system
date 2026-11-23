// Today and Live day as the screens read them (REC-F4, spec §11a): the words of a recon's day and freshness, a source's
// health and lag, the Space map as a graph (sources → recons, a source that is Degraded or Down marks every recon that
// reads it) and a day's numbers as the builder canvas's counters. Pure: the screens and their tests share it.
import type { LiveReconDto, LiveSourceDto, ReconRunDto, RunDay, TodayDto } from "@starterkit/shared/contracts/recon";
import type { BreakdownPart } from "@starterkit/ui/lib/breakdown";
import { APP_TIME_ZONE_LABEL, formatDateTime, formatDuration, formatNumber, formatTime } from "@starterkit/ui/lib/format";
import { type Chip, STATES, statusChip } from "@/lib/shared/categories";

import type { Health } from "@starterkit/ui/lib/status";
export const DAY_STATE_LABEL: Record<LiveReconDto["state"], string> = { open: "Open", closing: "Closing", closed: "Closed" };
const HEALTH_LABEL: Record<"healthy" | "degraded" | "down", string> = { healthy: "Healthy", degraded: "Degraded", down: "Down" };

/** A source's state for a chip: its health, or Unknown before its first publish. */
export function sourceChip(s: LiveSourceDto): { health: Health; label: string } {
  return s.health ? statusChip(s.health.state, HEALTH_LABEL[s.health.state]) : statusChip("no_data", "Not ingesting");
}
/** How far a source is: a pull's lag ("21 min behind"), else what it is complete through. */
export function sourceLag(s: LiveSourceDto): string {
  const h = s.health;
  if (!h) return "Not ingesting yet";
  if (h.lagSeconds != null) return `${formatDuration(h.lagSeconds)} behind`;
  return h.completeThrough ? `Complete through ${formatDateTime(Date.parse(h.completeThrough))}` : "Nothing complete yet";
}

/** The sources of `r` that are Degraded or Down (Space map: the recon is affected). */
export const troubled = (r: LiveReconDto, byId: ReadonlyMap<string, LiveSourceDto>) =>
  r.sides.map((s) => byId.get(s.sourceId)).filter((s): s is LiveSourceDto => !!s?.health && s.health.state !== "healthy");

/** A recon's state for a chip: Stale or affected by a source = Degraded or Down; else its day (Open blue, Closed green). */
export function reconChip(r: LiveReconDto, byId: ReadonlyMap<string, LiveSourceDto>): Chip {
  if (r.stale) return statusChip("stale", "Stale");
  const bad = troubled(r, byId);
  if (bad.some((s) => s.health!.state === "down")) return statusChip("down", "Source down");
  if (bad.length) return statusChip("degraded", "Source degraded");
  return { health: STATES.dayState[r.state], label: DAY_STATE_LABEL[r.state] };
}

/** "Runs every 2 min" / "Runs daily at 06:00". */
export const scheduleLine = (s: LiveReconDto["schedule"]) => (s.kind === "interval" ? `Runs every ${formatDuration(s.every_minutes * 60)}` : `Runs daily at ${s.at}`);

/**
 * When the schedule starts the next run (the Run card, audit R5): an interval recon's last scheduled start (its newest
 * tick run, `reconLastTick`) plus its interval (the schedule looks every minute, so once that has passed it is due now),
 * a daily one's time today, now during its minute, or tomorrow. ponytail: a date waiting for data or a failed run's backoff can hold it longer (engine rules.ts planRun);
 * the API would need the planner's own next moment to say so.
 */
export function nextRunText(s: LiveReconDto["schedule"], lastScheduledAt: string | null, now = Date.now()): string {
  if (s.kind === "daily") {
    const clock = formatTime(now);
    return clock === s.at ? "Next run due now" : `Next run at ${s.at} ${APP_TIME_ZONE_LABEL} ${clock < s.at ? "today" : "tomorrow"}`;
  }
  const next = lastScheduledAt ? Date.parse(lastScheduledAt) + s.every_minutes * 60_000 : 0;
  return next > now ? `Next run due at ${formatTime(next)} ${APP_TIME_ZONE_LABEL}` : "Next run due now";
}

/**
 * A recon's open unmatch per reason (the queue's facets) as BreakdownCard parts that add up to its unmatch: largest
 * first, so each takes its own series slot in order of size (two reasons may share a reason chip's colour, never a
 * part's), then the items without a reason, which the reason facet leaves out (the state facet counts every item).
 */
export function reasonParts(facets: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined): BreakdownPart[] {
  const parts = Object.entries(facets?.reason ?? {}).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  const total = Object.values(facets?.state ?? {}).reduce((n, v) => n + v, 0);
  const rest = total - parts.reduce((n, p) => n + p.value, 0);
  return rest > 0 ? [...parts, { label: "No reason", value: rest }] : parts;
}

/** A day's totals: items in, groups matched and suggested, waiting and broken items (both sides), side A's match rate. */
export function totalsOfDay(d: RunDay): { inItems: number | null; matched: number; suggested: number; waiting: number; breaks: number; rate: number | null } {
  const passes = Object.values(d.passes);
  const matched = passes.reduce((n, p) => n + p.matched, 0);
  return {
    inItems: d.items ? d.items.a + d.items.b : null, matched,
    suggested: passes.reduce((n, p) => n + p.suggested, 0),
    waiting: d.open.a + d.open.b,
    breaks: d.breaks.a + d.breaks.b + passes.reduce((n, p) => n + p.broken, 0),
    // one side A item per matched group, as the run summary counts it (an N:1 pass overcounts: ponytail in run-model)
    rate: d.items?.a ? Math.min(1, matched / d.items.a) : null,
  };
}
/** The current day's totals of a live recon; null before a run covered it. */
export const dayTotals = (r: LiveReconDto) => (r.day ? totalsOfDay(r.day) : null);

/**
 * The day as the builder canvas's counters (its edges then read the day): items in per side, nothing replaced, each
 * pass's groups and broken items, waiting per side.
 */
export function dayCounters(r: LiveReconDto): ReconRunDto["counters"] | undefined {
  const d = r.day;
  if (!d) return undefined;
  return { intake: d.items ?? { a: 0, b: 0 }, replaced: { a: 0, b: 0 }, open: d.open, passes: Object.fromEntries(Object.entries(d.passes).map(([k, p]) => [k, { ...p }])) };
}

export type MapNode = {
  id: string; lane: 0 | 1; title: string; line: string; chip: Chip;
  /** A recon: its page; the names of its sources that are Degraded or Down. */
  href?: string; affectedBy?: string[];
  /** A recon with a live run queued or under way, and when it started. */
  running?: "queued" | "running"; runStartedAt?: string;
  /** A source whose records just grew (useArrivals): by how many. */
  arriving?: number;
  /** A source's kind (its icon). */
  kind?: LiveSourceDto["kind"];
};
export type MapEdge = {
  id: string; source: string; target: string; /** 1–4 px: the source's records today against the busiest source's. */ width: number;
  /** Its recon is running: the edge flows. */
  live: boolean;
};

/**
 * The Space map (DEC-041, §11a): each source once (lane 0), each recon (lane 1), an edge per side. `arriving`: sources
 * whose records just grew; their node says so and their edges carry packets.
 */
export function spaceMap(t: TodayDto, hrefOf: (id: string) => string, arriving: ReadonlyMap<string, number> = new Map()): { nodes: MapNode[]; edges: MapEdge[] } {
  const byId = new Map(t.sources.map((s) => [s.id, s]));
  const busiest = Math.max(1, ...t.sources.map((s) => s.rowsToday ?? 0));
  // each source beside the first recon that reads it (then by name): edges run across, not over each other
  const first = (id: string) => { const i = t.recons.findIndex((r) => r.sides.some((x) => x.sourceId === id)); return i < 0 ? t.recons.length : i; };
  const ordered = [...t.sources].sort((a, b) => first(a.id) - first(b.id) || a.name.localeCompare(b.name));
  const nodes: MapNode[] = ordered.map((s) => ({
    id: `src-${s.id}`, lane: 0, title: s.name, chip: sourceChip(s), arriving: arriving.get(s.id), kind: s.kind,
    line: `${sourceLag(s)}${s.rowsToday != null ? ` · ${formatNumber(s.rowsToday)} today` : ""}`,
  }));
  const edges: MapEdge[] = [];
  for (const r of t.recons) {
    const bad = troubled(r, byId), tot = dayTotals(r);
    nodes.push({
      id: `rec-${r.id}`, lane: 1, title: r.name, chip: reconChip(r, byId), href: hrefOf(r.id), affectedBy: bad.map((s) => s.name), running: r.running?.status, runStartedAt: r.running?.startedAt,
      line: tot ? `${formatNumber(tot.waiting)} waiting · ${formatNumber(r.openBreaks)} unmatch` : `No run yet · ${formatNumber(r.openBreaks)} unmatch`,
    });
    for (const [i, s] of r.sides.entries()) {
      if (!byId.has(s.sourceId) || (i === 1 && s.sourceId === r.sides[0].sourceId)) continue;
      const rows = byId.get(s.sourceId)!.rowsToday ?? 0;
      edges.push({ id: `e-${s.sourceId}-${r.id}`, source: `src-${s.sourceId}`, target: `rec-${r.id}`, width: 1 + Math.round((3 * rows) / busiest), live: r.running?.status === "running" || arriving.has(s.sourceId) });
    }
  }
  return { nodes, edges };
}


/**
 * Today's KPI tray (audit T1): open unmatch items of its recons, posting runs of the last 24 hours that need someone
 * (failed, timeout, not sent), and sources whose health is degraded or down (behind their business date).
 */
export function todayKpis(t: Pick<TodayDto, "recons" | "sources" | "posting">) {
  return {
    unmatch: t.recons.reduce((n, r) => n + r.openBreaks, 0),
    posting: t.posting.reduce((n, p) => n + p.failed + p.timeout + p.notSent, 0),
    behind: t.sources.filter((s) => s.health?.state === "degraded" || s.health?.state === "down").length,
  };
}

/** A count as a tile shows it: "500+" when the server stopped counting there (`capped`). */
export const countText = (n: number, capped = false) => `${formatNumber(n)}${capped ? "+" : ""}`;

/**
 * A KPI tile's caption from its own read: it failed with nothing to show, it failed and keeps the last value, or the
 * tile's usual `caption`.
 */
export function kpiCaption(q: { data: unknown; error: unknown }, what: string, caption?: string): string | undefined {
  if (!q.error) return caption;
  return q.data === undefined ? `Couldn't load ${what}` : `Couldn't refresh ${what}; showing the last read`;
}
