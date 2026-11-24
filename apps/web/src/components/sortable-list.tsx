"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { Icon } from "@starterkit/ui/ui/icon";
import { DragHandleIcon } from "@starterkit/ui/ui/icons";
import { type Lift, moveItem, sortKey } from "./sortable-model";
import type { DragBits } from "./sortable-list-dnd";

// Every list the user orders by hand (owner 24 Nov: "free room", no arrow buttons). The rows, the grip handle and
// the keyboard live here; pointer and touch drag (dnd-kit) load with import() once a list of two rows or more
// renders, so dnd-kit stays out of every route's first load (AGENTS §9). Until it arrives the same rows render, and
// the keyboard already works. dnd-kit lives in apps/web, so this lives in components/ (features and /ds both use it).

type DndModule = typeof import("./sortable-list-dnd");
let loaded: DndModule | null = null;

export type SortableRow = {
  /** The row's place now (0-based): its number in labels ("Column 3 heading"). */
  index: number;
  /** The grip to place in the row (null when the list is disabled). */
  handle: ReactNode;
  /** Lifted by pointer, touch or keyboard. */
  dragging: boolean;
};

export type SortableListProps<T> = {
  items: readonly T[];
  /** A key that stays with the item when it moves; default its index. */
  getKey?: (item: T, index: number) => string;
  /** What one row is, for the handle and the announcements: "Column" → "Move column 2", "Column 2 moved to position 4 of 6." */
  noun: string;
  /** The list's accessible name. */
  label: string;
  onReorder: (next: T[], from: number, to: number) => void;
  renderItem: (item: T, row: SortableRow) => ReactNode;
  /** Read-only: no handle, no drag. */
  disabled?: boolean;
  /** The whole row drags too (a row without fields: a mouse press that moves 4 px, a long press on touch). */
  wholeRow?: boolean;
  className?: string;
  itemClassName?: string;
};

/** An ordered list whose rows move by drag (grip, or the whole row) and by keyboard on the grip. */
export function SortableList<T>({ items, getKey = (_, i) => String(i), noun, label, onReorder, renderItem, disabled, wholeRow, className, itemClassName }: SortableListProps<T>) {
  const [dnd, setDnd] = useState<DndModule | null>(loaded);
  const [lift, setLift] = useState<Lift | null>(null);
  const [said, setSaid] = useState("");
  const handles = useRef<(HTMLButtonElement | null)[]>([]);
  const hint = useId();
  const keys = items.map(getKey);
  const can = !disabled && items.length > 1;
  const name = (i: number) => `${noun} ${i + 1}`;

  useEffect(() => {
    if (!can || dnd) return;
    let on = true;
    // a failed chunk leaves the keyboard order: nothing to show
    import("./sortable-list-dnd").then((m) => { loaded = m; if (on) setDnd(m); }, () => undefined);
    return () => { on = false; };
  }, [can, dnd]);
  // the lifted row's handle keeps focus wherever the row went (a moved DOM node loses it, so does the swap to dnd rows)
  const at = lift?.at;
  useEffect(() => { if (at !== undefined) handles.current[at]?.focus(); }, [at, keys.join("\n"), dnd]);

  function onKey(e: KeyboardEvent, i: number) {
    const step = sortKey(lift, i, e.key, items.length, name);
    if (!step) return;
    e.preventDefault();
    setLift(step.lift);
    if (step.say) setSaid(step.say);
    if (step.move) onReorder(moveItem(items, step.move[0], step.move[1]), step.move[0], step.move[1]);
  }

  const row = (item: T, i: number) => (bits?: DragBits) => {
    const handle = can ? (
      <button ref={(el) => { handles.current[i] = el; bits?.setHandleRef(el); }} type="button" aria-label={`Move ${noun.toLowerCase()} ${i + 1}`}
        aria-describedby={hint} aria-pressed={lift?.at === i || undefined} {...bits?.listeners} onKeyDown={(e) => onKey(e, i)}
        // focus left the list (Tab, a click elsewhere): the row stays where it is
        onBlur={(e) => { if (lift && e.relatedTarget && !e.currentTarget.closest("ol")?.contains(e.relatedTarget as Node)) setLift(null); }}
        className="inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-tray hover:text-fg focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing">
        <Icon icon={DragHandleIcon} />
      </button>
    ) : null;
    return renderItem(item, { index: i, handle, dragging: !!bits?.dragging || lift?.at === i });
  };
  const lifted = (i: number) => lift?.at === i;
  const rows = items.map((item, i) => (dnd && can
    ? <dnd.DndItem key={keys[i]} id={keys[i]!} wholeRow={!!wholeRow} lifted={lifted(i)} className={itemClassName}>{row(item, i)}</dnd.DndItem>
    : <li key={keys[i]} className={cn(itemClassName, lifted(i) && "relative z-10 shadow-overlay")}>{row(item, i)()}</li>));

  return (
    <div className="contents">
      <ol aria-label={label} className={cn("grid", className)}>
        {dnd && can ? <dnd.DndList keys={keys} name={name} onMove={(from, to) => onReorder(moveItem(items, from, to), from, to)}>{rows}</dnd.DndList> : rows}
      </ol>
      {can && <span id={hint} hidden>Press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, Escape to cancel.</span>}
      <span data-slot="sortable-status" aria-live="assertive" className="sr-only">{said}</span>
    </div>
  );
}
