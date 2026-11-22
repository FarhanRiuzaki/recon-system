"use client";

import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { MenuIcon, RemoveIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { conditionParts, type Fields, keysText } from "./spec-model";

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
  /** What the pass still needs before the draft can be submitted (passNeeds), said on its card. */
  needs?: readonly string[];
  /** An example of what it paired in the shown simulation, under its outcome. */
  example?: ReactNode;
  /** false: the pass alone, no outcome column or connector (the setup's Matching step; results are the Test step's). */
  results?: boolean;
};
/** A labelled part of a pass card: a small heading, then its content; a line between parts. */
const Part = ({ label, children }: { label: string; children: ReactNode }) => (
  <span className="grid gap-1 border-t border-line pt-2">
    <span className="eyebrow text-fg-3">{label}</span>
    {children}
  </span>
);

/**
 * A pass as a card reads it (owner, 22 Nov: clear sections): its number and name, then Pairs when (each condition as
 * field | rule), Then (what happens to a pair, its shape, a tie) and Compares (every open item, or only the same …),
 * in the editor's order and words.
 */
export function PassBody({ pass, fields }: { pass: PassSpec; fields: Fields }) {
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-fg text-caption text-bg tabular">{pass.no}</span>
        <span className="min-w-0 truncate text-label text-fg">{pass.name || "Untitled pass"}</span>
      </span>
      <Part label="Pairs when">
        <ul className="grid gap-0.5">
          {pass.predicates.map((q, j) => {
            const c = conditionParts(q, fields);
            return (
              // the source columns on hover: two short columns beside the inspector (the Configuration shows them)
              <li key={j} title={c.columns} className="grid gap-x-3 text-body-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
                <span className="truncate text-fg">{c.field}</span>
                <span className="text-fg-2">{c.rule}</span>
              </li>
            );
          })}
        </ul>
      </Part>
      <Part label="Then">
        <span className="text-body-sm text-fg-2">
          <span className="text-fg">{pass.accept === "auto" ? "Matches it" : "Suggests it for review"}</span>
          {" · "}{CARD_SHAPE[pass.cardinality]}{" · "}{pass.on_ambiguous === "break" ? "several that fit stay unmatch" : "several that fit are suggested"}
        </span>
      </Part>
      <Part label="Compares">
        <span className="text-body-sm text-fg-2">{pass.blocking.length ? `Only items with the same ${keysText(pass.blocking)}` : "Every open item"}</span>
      </Part>
    </>
  );
}
const CARD_SHAPE: Record<PassSpec["cardinality"], string> = { "1:1": "1 on each side", "1:N": "1 on A, several on B", "N:1": "several on A, 1 on B" };

/** What dnd-kit's useSortable adds to a row once the sortable list has loaded (sortable-passes.tsx). */
export type SortableBits = {
  setNodeRef: Ref<HTMLLIElement>; setActivatorNodeRef: Ref<HTMLButtonElement>; handle: Record<string, unknown>; style?: CSSProperties; dragging: boolean;
};

/**
 * A pass of the run order: drag handle, the pass (select it; Alt+↑/↓ moves it), its outcome, its warnings, and the
 * connector under it. Every row has the same parts, so rows measure alike and a drop lands where the pointer is; the
 * same markup with or without `sortable`, so the list doesn't move when the sortable code arrives.
 */
export function PassRow({ id, pass, fields, selected, editable, notes = [], sim, onSelect, onKey, onRemove, needs = [], example, results = true, sortable }: PassRowProps & { sortable?: SortableBits }) {
  const dragging = !!sortable?.dragging;
  return (
    <li ref={sortable?.setNodeRef} style={sortable?.style}
      className={cn(dragging ? "relative z-10" : "motion-safe:transition-transform motion-safe:duration-(--dur-enter)")}>
      <div className={cn("grid gap-3", results ? "md:grid-cols-[minmax(0,1fr)_12rem]" : "mb-3")}>
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
            {needs.length > 0 && (
              <span className="flex items-start gap-1.5 text-body-sm text-degraded-ink">
                <Icon icon={WarningIcon} className="mt-0.5 size-3.5 shrink-0" />Needs: {needs.join(" · ")}
              </span>
            )}
          </button>
          {editable && onRemove && (
            <button type="button" onClick={onRemove} aria-label={`Remove pass ${pass.no}${pass.name ? ` (${pass.name})` : ""}`} title="Remove pass"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-down-ink hover:bg-down-soft focus-visible:outline-2 focus-visible:outline-primary">
              <Icon icon={RemoveIcon} />
            </button>
          )}
        </div>
        {results && <div className={cn("grid content-start gap-3 rounded-md border border-dashed border-line p-3 text-caption text-fg-3", sim?.dim && "opacity-60")}>
          {sim?.outcome.length ? sim.outcome.map((o) => (
            <span key={o.tag} className="grid gap-0.5">
              <span className={cn("justify-self-start rounded-sm px-1.5 py-0.5 text-label", o.tone === "warn" ? "bg-degraded-soft text-degraded-ink" : "bg-tray text-fg-2")}>{o.tag}</span>
              <span className="text-body-sm text-fg tabular">{o.count}</span>
              {o.note && <span>{o.note}</span>}
            </span>
          )) : (
            <span className="grid gap-1"><span className="text-label text-fg-2">{pass.accept === "auto" ? "Matched" : "Suggested"}</span><span>{DASH}</span></span>
          )}
          {example}
        </div>}
      </div>
      {notes.map((n) => <p key={n} className="flex items-start gap-1.5 pt-1.5 text-caption text-degraded-ink"><Icon icon={WarningIcon} className="mt-px size-3.5 shrink-0" />{n}</p>)}
      {results && <Connector text={sim ? sim.connector : undefined} dim={sim?.dim} />}
    </li>
  );
}
