"use client";

// The parts both canvases share (builder / Live day pipeline, Space map): a node card from DS tokens (an icon tile or
// a step number, title, a badge, one line, an accent for an outcome's status), a lane title, the dotted board and the
// fit: the graph always fits its card, on load, when it changes and when the card resizes.
// Live (owner, 21 Nov): a card whose run is under way sweeps (primary shimmer) with an indeterminate bar under it, and
// flashes once when the run ends; an edge into it carries packets along its path (SMIL animateMotion on the edge's own
// path, timed by DUR); hovering or focusing a node lights its whole path and dims the rest. Reduced motion: no sweep,
// bar, packets or flash; the primary stroke and the words stay.
import { Background, BackgroundVariant, BaseEdge, type Edge, type EdgeProps, getBezierPath, getSmoothStepPath, useReactFlow } from "@xyflow/react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { DUR, usePrefersReducedMotion } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
import { formatDuration } from "@starterkit/ui/lib/format";
import { Icon, type IconData } from "@starterkit/ui/ui/icon";
import { DiskIcon, FileIcon } from "@starterkit/ui/ui/icons";

/** The status colours an outcome or a marked node may carry (status colours are for health states only, AGENTS.md §6). */
export type Accent = "healthy" | "degraded" | "down" | "stopped" | "primary" | null;
const BAR: Record<Exclude<Accent, null>, string> = {
  healthy: "bg-healthy-mark", degraded: "bg-degraded-mark", down: "bg-down-mark", stopped: "bg-stopped-mark", primary: "bg-primary",
};
const TILE: Record<Exclude<Accent, null>, string> = {
  healthy: "bg-healthy-soft text-healthy-ink", degraded: "bg-degraded-soft text-degraded-ink", down: "bg-down-soft text-down-ink",
  stopped: "bg-stopped-soft text-stopped-ink", primary: "bg-primary-soft text-primary",
};

/**
 * A node's card. `step`: a pass's number in place of the icon. `marked`: a border in the accent (a recon a bad source
 * feeds). `running`: its run is under way (sweep, bar, the tile in primary); it flashes once when that ends.
 */
export function FlowCard({ icon, step, title, line, badge, accent = null, selected, marked, interactive, running }: {
  icon?: IconData; step?: number; title: string; line: string; badge?: ReactNode; accent?: Accent;
  selected?: boolean; marked?: boolean; interactive?: boolean; running?: boolean;
}) {
  const done = useEnded(!!running);
  return (
    <div className={cn(
      "relative flex h-full items-center gap-3 overflow-hidden rounded-lg border bg-card pr-3 pl-3.5 shadow-xs",
      selected ? "border-primary ring-2 ring-primary-soft" : running ? "border-primary" : marked && accent ? (accent === "down" ? "border-down-mark" : "border-degraded-mark") : "border-line",
      interactive && "cursor-pointer hover:border-line-strong hover:shadow-sm",
      done && "motion-safe:animate-row-new",
    )}>
      {running && <span aria-hidden="true" className="flow-sweep pointer-events-none absolute inset-0" />}
      {running && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary-soft">
          <span className="block h-full w-1/3 bg-primary animate-progress" />
        </span>
      )}
      {accent && <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", BAR[accent])} />}
      <span aria-hidden="true" className={cn("relative grid size-8 shrink-0 place-items-center rounded-md text-label tabular",
        running ? TILE.primary : accent ? TILE[accent] : "bg-tray text-fg-2")}>
        {step !== undefined ? step : icon ? <Icon icon={icon} size={16} /> : null}
      </span>
      <span className="relative grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-body-sm text-fg">{title}</span>
          {badge}
        </span>
        <span className="truncate text-caption text-fg-3">{line}</span>
      </span>
    </div>
  );
}

/** How a source's data arrives, as an icon: a database read or a file (the lists and the Space map tell them apart). */
export const sourceKindIcon = (kind: "db_watermark" | "db_snapshot" | "file_inbox"): IconData => (kind === "file_inbox" ? FileIcon : DiskIcon);
export const SOURCE_KIND_WORD: Record<"db_watermark" | "db_snapshot" | "file_inbox", string> = { db_watermark: "Database", db_snapshot: "Database snapshot", file_inbox: "File" };

/** A small badge inside a card (a pass's Auto / Suggest). */
export const FlowBadge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "primary" }) => (
  <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-caption", tone === "primary" ? "bg-primary-soft text-primary" : "bg-tray text-fg-2")}>{children}</span>
);

/** A lane's title above its column (inside the viewport, so it moves with the graph). */
export const LaneTitle = ({ x, label, count }: { x: number; label: string; count: number }) => (
  <div className="absolute flex items-center gap-1.5" style={{ transform: `translate(${x}px, -40px)` }}>
    <span className="eyebrow text-fg-3">{label}</span>
    <span className="rounded-full bg-card px-1.5 text-caption text-fg-3 tabular ring-1 ring-line">{count}</span>
  </div>
);

/** The board: dots on the canvas's surface (their colour from --xy-background-pattern-color, recon-canvas.css). */
export const FlowBoard = () => <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} />;

/**
 * Fit options of both canvases: a margin all round and room above for the lane titles (they sit 40 px over the nodes,
 * outside the nodes' bounds), never past 100 % (a small graph stays at reading size).
 */
export const FIT = { padding: { top: "64px", right: "32px", bottom: "32px", left: "32px" }, maxZoom: 1, minZoom: 0.3 } as const;

/**
 * The graph fits its card: again whenever `key` changes (another graph) and whenever the card resizes (the window, the
 * sidebar, the inspector sheet). Inside a ReactFlowProvider.
 */
export function useFitToCard(wrap: RefObject<HTMLDivElement | null>, key: unknown) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => void fitView(FIT));
    return () => cancelAnimationFrame(id);
  }, [key, fitView]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let frame = 0;
    const obs = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => void fitView(FIT)); });
    obs.observe(el);
    return () => { obs.disconnect(); cancelAnimationFrame(frame); };
  }, [wrap, fitView]);
}

/** True for one flash after `on` turns false (a run that just ended). */
function useEnded(on: boolean): boolean {
  const was = useRef(on);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (was.current && !on) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), DUR.flash * 1000);
      was.current = on;
      return () => clearTimeout(t);
    }
    was.current = on;
  }, [on]);
  return flash;
}

/** Seconds since `iso`, ticking every second while set ("42 s", "3 min 5 s"); null without one. */
export function useElapsed(iso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  return iso ? formatDuration(Math.max(0, Math.round((now - Date.parse(iso)) / 1000))) : null;
}

/** An edge's live data: `live` = packets flow along it; `kind` step = a pass to the next, down its lane. */
export type FlowEdgeData = { live?: boolean; kind?: "step" };

/** The edge both canvases draw: its path, its label as a pill, and while live two packets travelling it (not under reduced motion). */
export function FlowEdge(p: EdgeProps<Edge<FlowEdgeData>>) {
  const reduced = usePrefersReducedMotion();
  const [path, labelX, labelY] = p.data?.kind === "step"
    ? getSmoothStepPath({ ...p, borderRadius: 12 })
    : getBezierPath(p);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} label={p.label} labelX={labelX} labelY={labelY}
        labelStyle={p.labelStyle} labelShowBg={p.labelShowBg} labelBgStyle={p.labelBgStyle} labelBgPadding={p.labelBgPadding} labelBgBorderRadius={p.labelBgBorderRadius} />
      {p.data?.live && !reduced && [0, DUR.tween].map((at) => (
        // a packet with a soft halo, both on the edge's own path
        <g key={at}>
          <circle r={7} className="flow-halo"><animateMotion dur={`${DUR.flash}s`} begin={`-${at}s`} repeatCount="indefinite" path={path} /></circle>
          <circle r={3.5} className="flow-packet"><animateMotion dur={`${DUR.flash}s`} begin={`-${at}s`} repeatCount="indefinite" path={path} /></circle>
        </g>
      ))}
    </>
  );
}
export const EDGE_TYPES = { flow: FlowEdge };

/**
 * What a hovered or focused node lights: itself, every node upstream and downstream of it, and the edges between.
 * Null = nothing hovered (everything at full strength).
 */
export function pathOf(id: string | null, edges: readonly { id: string; source: string; target: string }[]): { nodes: Set<string>; edges: Set<string> } | null {
  if (!id) return null;
  const nodes = new Set([id]), lit = new Set<string>();
  for (const dir of ["down", "up"] as const) {
    const queue = [id];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of edges) {
        const from = dir === "down" ? e.source : e.target, to = dir === "down" ? e.target : e.source;
        if (from !== at || lit.has(e.id)) continue;
        lit.add(e.id);
        if (!nodes.has(to)) { nodes.add(to); queue.push(to); }
      }
    }
  }
  return { nodes, edges: lit };
}

/** The hovered or focused node of a canvas (mouse or keyboard), for pathOf. */
export function useHotNode() {
  const [hot, setHot] = useState<string | null>(null);
  const idOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.(".react-flow__node")?.getAttribute("data-id") ?? null;
  return {
    hot,
    onNodeMouseEnter: (_: unknown, n: { id: string }) => setHot(n.id),
    onNodeMouseLeave: () => setHot(null),
    onFocusCapture: (e: { target: EventTarget | null }) => setHot(idOf(e.target)),
    onBlurCapture: () => setHot(null),
  };
}

/** How long a source's new records show as arriving (its sweep, packets and "+N just in") after a read saw them. */
export const ARRIVAL_SHOWN_MS = 8_000;
/** The sources of `now` whose count grew since `before`, by how much (one absent before isn't new: it just appeared). */
export function grownSince(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...now].flatMap(([id, n]) => (before.has(id) && n > before.get(id)! ? [[id, n - before.get(id)!] as const] : [])));
}

/**
 * Sources whose records for the day grew since the last read of the screen (a poll): their growth, for ARRIVAL_SHOWN_MS.
 * The first read only sets the baseline (nothing arrives on load).
 */
export function useArrivals(sources: readonly { id: string; rowsToday: number | null }[] | undefined): ReadonlyMap<string, number> {
  const seen = useRef<Map<string, number> | null>(null);
  const [arriving, setArriving] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!sources) return;
    const now = new Map(sources.map((s) => [s.id, s.rowsToday ?? 0]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const grown = grownSince(before, now);
    if (!grown.size) return;
    setArriving(grown);
    const t = setTimeout(() => setArriving(new Map()), ARRIVAL_SHOWN_MS);
    return () => clearTimeout(t);
  }, [sources]);
  return arriving;
}
