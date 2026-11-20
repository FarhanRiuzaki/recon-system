"use client";

import type { CSSProperties, KeyboardEvent, Ref } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { MenuIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { conditionText, type Fields, pairText } from "./spec-model";

export const DASH = "—";

/** "In / Left / Unmatched" between the items once a simulation ran; until then every connector says so. */
export const Connector = () => <div className="ml-5 border-l border-line py-2 pl-4 text-caption text-fg-3">Not simulated</div>;

export type PassRowProps = {
  id: string; pass: PassSpec; fields: Fields; selected: boolean; editable: boolean; onSelect: () => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** The API's warnings about this pass (a currency without tolerance), shown under it. */
  notes?: readonly string[];
};
/** What dnd-kit's useSortable adds to a row once the sortable list has loaded (sortable-passes.tsx). */
export type SortableBits = {
  setNodeRef: Ref<HTMLLIElement>; setActivatorNodeRef: Ref<HTMLButtonElement>; handle: Record<string, unknown>; style?: CSSProperties; dragging: boolean;
};

/**
 * A pass of the run order: drag handle, the pass (select it; Alt+↑/↓ moves it), its outcome, its warnings, and the
 * connector under it. Every row has the same parts, so rows measure alike and a drop lands where the pointer is; the
 * same markup with or without `sortable`, so the list doesn't move when the sortable code arrives.
 */
export function PassRow({ id, pass, fields, selected, editable, notes = [], onSelect, onKey, sortable }: PassRowProps & { sortable?: SortableBits }) {
  const dragging = !!sortable?.dragging;
  return (
    <li ref={sortable?.setNodeRef} style={sortable?.style}
      className={cn(dragging ? "relative z-10" : "motion-safe:transition-transform motion-safe:duration-(--dur-enter)")}>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem]">
        <div className={cn("flex min-w-0 items-start gap-1 rounded-md border bg-card p-3", selected ? "border-fg shadow-sm" : "border-line", dragging && "shadow-overlay")}>
          {editable && (
            <button ref={sortable?.setActivatorNodeRef} type="button" {...sortable?.handle} aria-label={`Drag pass ${pass.no}`}
              className="mt-0.5 inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary">
              <Icon icon={MenuIcon} />
            </button>
          )}
          <button id={`pass-${id}`} type="button" aria-pressed={selected} onClick={onSelect} onKeyDown={onKey}
            className="grid min-w-0 flex-1 gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <span className="flex items-center gap-2">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-fg text-caption text-bg tabular">{pass.no}</span>
              <span className="min-w-0 truncate text-label text-fg">{pass.name}</span>
            </span>
            <span className="flex flex-wrap gap-1.5 text-caption text-fg-2">
              <span className="rounded-sm bg-tray px-1.5 py-0.5">{pass.cardinality}</span>
              <span className="rounded-sm bg-tray px-1.5 py-0.5">{pass.accept === "auto" ? "Auto-accept" : "Suggest"}</span>
              {pass.blocking.length > 0 && <span className="rounded-sm bg-tray px-1.5 py-0.5">Candidates by {pass.blocking.map((f) => pairText(f, fields)).join(", ")}</span>}
            </span>
            <span className="grid gap-0.5 font-mono text-mono text-fg-2 wrap-anywhere">
              {pass.predicates.map((q, j) => <span key={j}>{conditionText(q, fields)}</span>)}
            </span>
          </button>
        </div>
        <div className="grid content-start gap-1 rounded-md border border-dashed border-line p-3 text-caption text-fg-3">
          <span className="text-label text-fg-2">{pass.accept === "auto" ? "Matched" : "Suggested"}</span>
          <span>{DASH}</span>
        </div>
      </div>
      {notes.map((n) => <p key={n} className="flex items-start gap-1.5 pt-1.5 text-caption text-degraded-ink"><Icon icon={WarningIcon} className="mt-px size-3.5 shrink-0" />{n}</p>)}
      <Connector />
    </li>
  );
}
