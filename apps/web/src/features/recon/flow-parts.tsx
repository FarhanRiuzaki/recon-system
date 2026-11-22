"use client";

// The parts both canvases share (builder / Live day pipeline, Space map): a node card from DS tokens (an icon tile or
// a step number, title, a badge, one line, an accent for an outcome's status), a lane title, the dotted board and the
// fit: the graph always fits its card, on load, when it changes and when the card resizes.
// Live (owner, 21 Nov): a card whose run is under way sweeps (primary shimmer) with an indeterminate bar under it, and
// flashes once when the run ends; an edge into it carries packets along its path (SMIL animateMotion on the edge's own
// path, timed by DUR); hovering or focusing a node lights its whole path and dims the rest. Reduced motion: no sweep,
// bar, packets or flash; the primary stroke and the words stay.
import { Background, BackgroundVariant, BaseEdge, ControlButton, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath, getSmoothStepPath, Handle, Position, useReactFlow } from "@xyflow/react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { DUR, usePrefersReducedMotion } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon, type IconData } from "@starterkit/ui/ui/icon";
import { ResetIcon } from "@starterkit/ui/ui/icons";

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

/**
 * What an edge means, as its colour (and its arrow's): an outcome it feeds (matched, suggested, waiting, a break) or the
 * health of the source it comes from (degraded, down). Null = a plain step of the flow.
 */
export type EdgeTone = "matched" | "suggested" | "waiting" | "break" | "degraded" | "down" | null;
const TONE_COLOR: Record<Exclude<EdgeTone, null>, string> = {
  matched: "var(--healthy-mark)", suggested: "var(--primary)", waiting: "var(--fg-4)", break: "var(--degraded-mark)", degraded: "var(--degraded-mark)", down: "var(--down-mark)",
};
/** The arrow at an edge's end, in its tone's colour (React Flow draws one marker per colour). */
export const arrowOf = (tone: EdgeTone, live = false) =>
  ({ type: "arrowclosed" as const, color: live ? "var(--primary)" : tone ? TONE_COLOR[tone] : "var(--fg-4)", width: 12, height: 12 });

/**
 * An edge's data: `live` = packets flow along it; `kind` step = a pass to the next, down its lane; `tone` its colour;
 * `text` its label (a count), drawn as a pill; `quiet` = a count of zero, muted.
 */
export type FlowEdgeData = { live?: boolean; kind?: "step"; tone?: EdgeTone; text?: string; quiet?: boolean };

/**
 * The edge both canvases draw: a smooth curve leaving and entering its cards level (each edge has its own port, see
 * `ports`), in its tone's colour; its count as a pill on the curve; while live two packets travel it (not under
 * reduced motion); a waiting edge is dashed (nothing happened to those items yet).
 */
export function FlowEdge(p: EdgeProps<Edge<FlowEdgeData>>) {
  const reduced = usePrefersReducedMotion();
  const [path, labelX, labelY] = p.data?.kind === "step"
    ? getSmoothStepPath({ ...p, borderRadius: 10 })
    : getBezierPath({ ...p, curvature: 0.35 });
  const tone = p.data?.tone ?? null;
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} interactionWidth={16}
        style={{ ...p.style, ...(tone ? { stroke: TONE_COLOR[tone] } : {}), ...(tone === "waiting" ? { strokeDasharray: "5 4" } : {}) }} />
      {p.data?.text && (
        <EdgeLabelRenderer>
          <span className={cn("flow-label nodrag nopan", p.data.quiet && "is-quiet")} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{p.data.text}</span>
        </EdgeLabelRenderer>
      )}
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

/** Where an edge leaves its source card and enters its target card: a fraction of the card's height. */
export type Ports = Map<string, { out: number; in: number }>;
/**
 * A port per edge on each card side (no two edges share a point, so they never cross where they meet a card): a card's
 * outgoing edges ordered by where their targets sit, incoming by where their sources sit, spread over the middle of
 * its height. Read from the nodes' current positions, so a dragged card re-orders its ports. `skip`: edges with their
 * own handles (a pass to the next, top to bottom).
 */
export function ports(edges: readonly { id: string; source: string; target: string }[], y: (id: string) => number, skip: (id: string) => boolean = () => false): Ports {
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>();
  const by = (m: Map<string, string[]>, k: string, id: string) => { const l = m.get(k) ?? []; l.push(id); m.set(k, l); };
  const live = edges.filter((e) => !skip(e.id));
  for (const e of live) { by(out, e.source, e.id); by(inn, e.target, e.id); }
  const ends = new Map(live.map((e) => [e.id, e]));
  const at = (ids: string[], other: (id: string) => number) => {
    const sorted = [...ids].sort((a, b) => other(a) - other(b));
    return new Map(sorted.map((id, i) => [id, sorted.length === 1 ? 0.5 : 0.25 + (0.5 * i) / (sorted.length - 1)]));
  };
  const res: Ports = new Map();
  const outAt = new Map<string, number>(), inAt = new Map<string, number>();
  for (const ids of out.values()) for (const [id, f] of at(ids, (x) => y(ends.get(x)!.target))) outAt.set(id, f);
  for (const ids of inn.values()) for (const [id, f] of at(ids, (x) => y(ends.get(x)!.source))) inAt.set(id, f);
  for (const e of live) res.set(e.id, { out: outAt.get(e.id) ?? 0.5, in: inAt.get(e.id) ?? 0.5 });
  return res;
}
/** A card's ports as handles: `outs` on its right, `ins` on its left, each at its fraction of the height. */
export function PortHandles({ ins, outs }: { ins: readonly [string, number][]; outs: readonly [string, number][] }) {
  return (
    <>
      {ins.map(([id, f]) => <Handle key={`i-${id}`} id={`i-${id}`} type="target" position={Position.Left} isConnectable={false} style={{ top: `${f * 100}%` }} />)}
      {outs.map(([id, f]) => <Handle key={`o-${id}`} id={`o-${id}`} type="source" position={Position.Right} isConnectable={false} style={{ top: `${f * 100}%` }} />)}
    </>
  );
}
/** The ports of node `id` from `p`, for PortHandles. */
export function portsOf(id: string, edges: readonly { id: string; source: string; target: string }[], p: Ports) {
  return {
    ins: edges.filter((e) => e.target === id && p.has(e.id)).map((e) => [e.id, p.get(e.id)!.in] as [string, number]),
    outs: edges.filter((e) => e.source === id && p.has(e.id)).map((e) => [e.id, p.get(e.id)!.out] as [string, number]),
  };
}

/** The Controls button that puts every card back where the layout placed it (after dragging them around). */
export const ResetLayout = ({ onReset }: { onReset: () => void }) => (
  <ControlButton onClick={onReset} title="Reset layout" aria-label="Reset layout">
    <Icon icon={ResetIcon} size={14} />
  </ControlButton>
);

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
