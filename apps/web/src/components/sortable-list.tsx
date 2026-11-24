"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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

/** Where focus is inside `list`, as child indexes from the list down, with a text field's selection. */
type FocusAt = { path: number[]; sel: [number | null, number | null] | null };
function focusAt(list: HTMLElement | null): FocusAt | null {
  const el = document.activeElement;
  if (!list || !el || el === list || !list.contains(el)) return null;
  const path: number[] = [];
  for (let n: Element = el; n !== list; n = n.parentElement!) path.unshift([...n.parentElement!.children].indexOf(n));
  let sel: FocusAt["sel"] = null;
  try { if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) sel = [el.selectionStart, el.selectionEnd]; } catch { /* no selection on this type */ }
  return { path, sel };
}
function refocus(list: HTMLElement | null, at: FocusAt) {
  let n: Element | undefined = list ?? undefined;
  for (const i of at.path) n = n?.children[i];
  if (!(n instanceof HTMLElement)) return;
  n.focus();
  try { if (at.sel && (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement)) n.setSelectionRange(at.sel[0], at.sel[1]); } catch { /* no selection on this type */ }
}

export type SortableRow = {
  /** The row's place now (0-based): its number in labels ("Column 3 heading"). */
  index: number;
  /** The grip to place in the row (null when the list can't be sorted: disabled, or one row). */
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
  const listRef = useRef<HTMLOListElement>(null);
  const kept = useRef<FocusAt | null>(null);
  const hint = useId();
  const keys = items.map(getKey);
  const can = !disabled && items.length > 1;
  const name = (i: number) => `${noun} ${i + 1}`;

  useEffect(() => {
    if (!can || dnd) return;
    let on = true;
    // the rows remount as dnd rows: focus (and a field's caret) goes back where it was; a failed chunk keeps the keyboard
    import("./sortable-list-dnd").then((m) => { loaded = m; if (on) { kept.current = focusAt(listRef.current); setDnd(m); } }, () => undefined);
    return () => { on = false; };
  }, [can, dnd]);
  useLayoutEffect(() => { if (kept.current) refocus(listRef.current, kept.current); kept.current = null; }, [dnd]);
  // the lifted row's handle keeps focus wherever the row went (a moved DOM node loses it)
  const at = lift?.at, order = keys.join("\n");
  useEffect(() => { if (at !== undefined) handles.current[at]?.focus(); }, [at, order]);

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
        onBlur={(e) => { if (lift && e.relatedTarget && !listRef.current?.contains(e.relatedTarget as Node)) setLift(null); }}
        className="inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-3 hover:bg-tray hover:text-fg focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing">
        <Icon icon={DragHandleIcon} />
      </button>
    ) : null;
    return renderItem(item, { index: i, handle, dragging: !!bits?.dragging || lift?.at === i });
  };
  const lifted = (i: number) => lift?.at === i;
  // once loaded, the rows stay dnd rows (drag off while the list can't sort), so they remount only that once
  const rows = items.map((item, i) => (dnd
    ? <dnd.DndItem key={keys[i]} id={keys[i]!} disabled={!can} wholeRow={!!wholeRow} lifted={lifted(i)} className={itemClassName}>{row(item, i)}</dnd.DndItem>
    : <li key={keys[i]} className={cn(itemClassName, lifted(i) && "relative z-10 shadow-overlay")}>{row(item, i)()}</li>));

  return (
    <div className="contents">
      <ol ref={listRef} aria-label={label} className={cn("grid", className)}>
        {dnd ? <dnd.DndList keys={keys} name={name} onMove={(from, to) => onReorder(moveItem(items, from, to), from, to)}>{rows}</dnd.DndList> : rows}
      </ol>
      {can && <span id={hint} hidden>Press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, Escape to cancel.</span>}
      <span data-slot="sortable-status" aria-live="assertive" className="sr-only">{said}</span>
    </div>
  );
}
