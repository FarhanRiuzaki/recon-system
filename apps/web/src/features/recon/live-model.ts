// Today and Live day as the screens read them (REC-F4, spec §11a): the words of a recon's day and freshness, a source's
// health and lag, the Space map as a graph (sources → recons, a source that is Degraded or Down marks every recon that
// reads it) and a day's numbers as the builder canvas's counters. Pure: the screens and their tests share it.
import type { LiveReconDto, LiveSourceDto, ReconRunDto, TodayDto } from "@starterkit/shared/contracts/recon";
import { formatDateTime, formatDuration, formatNumber } from "@starterkit/ui/lib/format";

type Health = "healthy" | "degraded" | "down" | "stopped" | "unknown";
export const DAY_STATE_LABEL: Record<LiveReconDto["state"], string> = { open: "Open", closing: "Closing", closed: "Closed" };
const HEALTH_LABEL: Record<"healthy" | "degraded" | "down", string> = { healthy: "Healthy", degraded: "Degraded", down: "Down" };

/** A source's state for a chip: its health, or Unknown before its first publish. */
export function sourceChip(s: LiveSourceDto): { health: Health; label: string } {
  return s.health ? { health: s.health.state, label: HEALTH_LABEL[s.health.state] } : { health: "unknown", label: "Not ingesting" };
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

/** A recon's state for a chip: Stale or affected by a source = Degraded; else its day, healthy. */
export function reconChip(r: LiveReconDto, byId: ReadonlyMap<string, LiveSourceDto>): { health: Health; label: string } {
  if (r.stale) return { health: "degraded", label: "Stale" };
  const bad = troubled(r, byId);
  if (bad.some((s) => s.health!.state === "down")) return { health: "down", label: "Source down" };
  if (bad.length) return { health: "degraded", label: "Source degraded" };
  return { health: r.state === "closed" ? "stopped" : "healthy", label: DAY_STATE_LABEL[r.state] };
}

/** "Runs every 2 min" / "Runs daily at 06:00". */
export const scheduleLine = (s: LiveReconDto["schedule"]) => (s.kind === "interval" ? `Runs every ${formatDuration(s.every_minutes * 60)}` : `Runs daily at ${s.at}`);

/** The day's totals: items in, groups matched and suggested, waiting and broken items (both sides). Null before a run. */
export function dayTotals(r: LiveReconDto): { inItems: number | null; matched: number; suggested: number; waiting: number; breaks: number } | null {
  const d = r.day;
  if (!d) return null;
  const passes = Object.values(d.passes);
  return {
    inItems: d.items ? d.items.a + d.items.b : null,
    matched: passes.reduce((n, p) => n + p.matched, 0),
    suggested: passes.reduce((n, p) => n + p.suggested, 0),
    waiting: d.open.a + d.open.b,
    breaks: d.breaks.a + d.breaks.b + passes.reduce((n, p) => n + p.broken, 0),
  };
}

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
  id: string; lane: 0 | 1; title: string; line: string; chip: { health: Health; label: string };
  /** A recon: its page; the names of its sources that are Degraded or Down. */
  href?: string; affectedBy?: string[];
  /** A recon with a live run queued or under way, and when it started. */
  running?: "queued" | "running"; runStartedAt?: string;
};
export type MapEdge = {
  id: string; source: string; target: string; /** 1–4 px: the source's records today against the busiest source's. */ width: number;
  /** Its recon is running: the edge flows. */
  live: boolean;
};

/** The Space map (DEC-041, §11a): each source once (lane 0), each recon (lane 1), an edge per side. */
export function spaceMap(t: TodayDto, hrefOf: (id: string) => string): { nodes: MapNode[]; edges: MapEdge[] } {
  const byId = new Map(t.sources.map((s) => [s.id, s]));
  const busiest = Math.max(1, ...t.sources.map((s) => s.rowsToday ?? 0));
  // each source beside the first recon that reads it (then by name): edges run across, not over each other
  const first = (id: string) => { const i = t.recons.findIndex((r) => r.sides.some((x) => x.sourceId === id)); return i < 0 ? t.recons.length : i; };
  const ordered = [...t.sources].sort((a, b) => first(a.id) - first(b.id) || a.name.localeCompare(b.name));
  const nodes: MapNode[] = ordered.map((s) => ({
    id: `src-${s.id}`, lane: 0, title: s.name, chip: sourceChip(s),
    line: `${sourceLag(s)}${s.rowsToday != null ? ` · ${formatNumber(s.rowsToday)} today` : ""}`,
  }));
  const edges: MapEdge[] = [];
  for (const r of t.recons) {
    const bad = troubled(r, byId), tot = dayTotals(r);
    nodes.push({
      id: `rec-${r.id}`, lane: 1, title: r.name, chip: reconChip(r, byId), href: hrefOf(r.id), affectedBy: bad.map((s) => s.name), running: r.running?.status, runStartedAt: r.running?.startedAt,
      line: tot ? `${formatNumber(tot.waiting)} waiting · ${formatNumber(r.openBreaks)} open breaks` : `No run yet · ${formatNumber(r.openBreaks)} open breaks`,
    });
    for (const [i, s] of r.sides.entries()) {
      if (!byId.has(s.sourceId) || (i === 1 && s.sourceId === r.sides[0].sourceId)) continue;
      const rows = byId.get(s.sourceId)!.rowsToday ?? 0;
      edges.push({ id: `e-${s.sourceId}-${r.id}`, source: `src-${s.sourceId}`, target: `rec-${r.id}`, width: 1 + Math.round((3 * rows) / busiest), live: r.running?.status === "running" });
    }
  }
  return { nodes, edges };
}

