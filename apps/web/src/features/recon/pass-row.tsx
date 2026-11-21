"use client";

import type { CSSProperties, KeyboardEvent, Ref } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { MenuIcon, RemoveIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { CARDINALITY_WORDS, conditionParts, type Fields, keysText } from "./spec-model";

export const DASH = "—";

/**
 * "In / Left / Unmatched" between the items once a simulation ran (`text`; null = a count the run can't split per side,
 * an empty line); until then (`text` undefined) every connector says so.
 */
export const Connector = ({ text, dim }: { text?: string | null; dim?: boolean }) => (
  <div className={cn("ml-5 border-l border-line py-2 pl-4 text-caption text-fg-3 tabular", dim && "opacity-60")}>{text === undefined ? "Not simulated" : (text ?? "\u00a0")}</div>
);
/** What a pass did in the shown simulation (run-model passOutcome); undefined = not simulated. */
export type Outcome = { tag: string; tone: "neutral" | "warn"; count: string; note: string };

export type PassRowProps = {
  id: string; pass: PassSpec; fields: Fields; selected: boolean; editable: boolean; onSelect: () => void; onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** The API's warnings about this pass (a currency without tolerance), shown under it. */
  notes?: readonly string[];
  /** The shown simulation: this pass's outcome, the connector under it, dimmed while out of date or running. */
  sim?: { outcome: Outcome[]; connector: string | null; dim: boolean };
  /** Remove the pass from the card itself (owner, 22 Nov), with Undo as from the inspector; none read only. */
  onRemove?: () => void;
};
/** A pass as text: its number and name, cardinality, when found, the matching keys and every condition. */
export function PassBody({ pass, fields }: { pass: PassSpec; fields: Fields }) {
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-fg text-caption text-bg tabular">{pass.no}</span>
        <span className="min-w-0 truncate text-label text-fg">{pass.name}</span>
      </span>
      <span className="flex flex-wrap gap-1.5 text-caption text-fg-2">
        <span className="rounded-sm bg-tray px-1.5 py-0.5">{CARDINALITY_WORDS[pass.cardinality]}</span>
        <span className="rounded-sm bg-tray px-1.5 py-0.5">{pass.accept === "auto" ? "Matches automatically" : "Suggests for review"}</span>
        {pass.blocking.length > 0 && <span className="rounded-sm bg-tray px-1.5 py-0.5">Looks at the same {keysText(pass.blocking)}</span>}
      </span>
      {/* each condition in people's words, its source column after it (owner, 22 Nov: clear, not the engine's words) */}
      <ul className="grid gap-0.5">
        {pass.predicates.map((q, j) => {
          const c = conditionParts(q, fields);
          return (
            <li key={j} className="grid gap-x-3 text-body-sm wrap-anywhere sm:grid-cols-[8rem_minmax(0,1fr)]">
              <span className="text-fg">{c.field}</span>
              <span className="text-fg-2">{c.rule}<span className="ml-2 font-mono text-caption text-fg-3">{c.columns}</span></span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** What dnd-kit's useSortable adds to a row once the sortable list has loaded (sortable-passes.tsx). */
export type SortableBits = {
  setNodeRef: Ref<HTMLLIElement>; setActivatorNodeRef: Ref<HTMLButtonElement>; handle: Record<string, unknown>; style?: CSSProperties; dragging: boolean;
};

/**
 * A pass of the run order: drag handle, the pass (select it; Alt+↑/↓ moves it), its outcome, its warnings, and the
 * connector under it. Every row has the same parts, so rows measure alike and a drop lands where the pointer is; the
 * same markup with or without `sortable`, so the list doesn't move when the sortable code arrives.
 */
export function PassRow({ id, pass, fields, selected, editable, notes = [], sim, onSelect, onKey, onRemove, sortable }: PassRowProps & { sortable?: SortableBits }) {
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
            <PassBody pass={pass} fields={fields} />
          </button>
          {editable && onRemove && (
            <button type="button" onClick={onRemove} aria-label={`Remove pass ${pass.no}${pass.name ? ` (${pass.name})` : ""}`} title="Remove pass"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-tray hover:text-fg focus-visible:outline-2 focus-visible:outline-primary">
              <Icon icon={RemoveIcon} />
            </button>
          )}
        </div>
        <div className={cn("grid content-start gap-3 rounded-md border border-dashed border-line p-3 text-caption text-fg-3", sim?.dim && "opacity-60")}>
          {sim?.outcome.length ? sim.outcome.map((o) => (
            <span key={o.tag} className="grid gap-0.5">
              <span className={cn("justify-self-start rounded-sm px-1.5 py-0.5 text-label", o.tone === "warn" ? "bg-degraded-soft text-degraded-ink" : "bg-tray text-fg-2")}>{o.tag}</span>
              <span className="text-body-sm text-fg tabular">{o.count}</span>
              {o.note && <span>{o.note}</span>}
            </span>
          )) : (
            <span className="grid gap-1"><span className="text-label text-fg-2">{pass.accept === "auto" ? "Matched" : "Suggested"}</span><span>{DASH}</span></span>
          )}
        </div>
      </div>
      {notes.map((n) => <p key={n} className="flex items-start gap-1.5 pt-1.5 text-caption text-degraded-ink"><Icon icon={WarningIcon} className="mt-px size-3.5 shrink-0" />{n}</p>)}
      <Connector text={sim ? sim.connector : undefined} dim={sim?.dim} />
    </li>
  );
}
