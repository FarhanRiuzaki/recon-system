"use client";

// The parts both canvases share (builder / Live day pipeline, Space map): a node card from DS tokens (an icon tile or
// a step number, title, a badge, one line, an accent for an outcome's status), a lane title, the dotted board and the
// fit: the graph always fits its card, on load, when it changes and when the card resizes.
import { Background, BackgroundVariant, useReactFlow } from "@xyflow/react";
import { type ReactNode, type RefObject, useEffect } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon, type IconData } from "@starterkit/ui/ui/icon";

/** The status colours an outcome or a marked node may carry (status colours are for health states only, AGENTS.md §6). */
export type Accent = "healthy" | "degraded" | "down" | "stopped" | "primary" | null;
const BAR: Record<Exclude<Accent, null>, string> = {
  healthy: "bg-healthy-mark", degraded: "bg-degraded-mark", down: "bg-down-mark", stopped: "bg-stopped-mark", primary: "bg-primary",
};
const TILE: Record<Exclude<Accent, null>, string> = {
  healthy: "bg-healthy-soft text-healthy-ink", degraded: "bg-degraded-soft text-degraded-ink", down: "bg-down-soft text-down-ink",
  stopped: "bg-stopped-soft text-stopped-ink", primary: "bg-primary-soft text-primary",
};

/** A node's card. `step`: a pass's number in place of the icon. `marked`: a border in the accent (a recon a bad source feeds). */
export function FlowCard({ icon, step, title, line, badge, accent = null, selected, marked, interactive }: {
  icon?: IconData; step?: number; title: string; line: string; badge?: ReactNode; accent?: Accent;
  selected?: boolean; marked?: boolean; interactive?: boolean;
}) {
  return (
    <div className={cn(
      "relative flex h-full items-center gap-3 overflow-hidden rounded-lg border bg-card pr-3 pl-3.5 shadow-xs",
      selected ? "border-primary ring-2 ring-primary-soft" : marked && accent ? (accent === "down" ? "border-down-mark" : "border-degraded-mark") : "border-line",
      interactive && "cursor-pointer hover:border-line-strong hover:shadow-sm",
    )}>
      {accent && <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", BAR[accent])} />}
      <span aria-hidden="true" className={cn("grid size-8 shrink-0 place-items-center rounded-md text-label tabular", accent ? TILE[accent] : "bg-tray text-fg-2")}>
        {step !== undefined ? step : icon ? <Icon icon={icon} size={16} /> : null}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
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

/** Fit options of both canvases: room for the lane titles, never past 100 % (a small graph stays at reading size). */
export const FIT = { padding: 0.1, maxZoom: 1, minZoom: 0.3 } as const;

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
