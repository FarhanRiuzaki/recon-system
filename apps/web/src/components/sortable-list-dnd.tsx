"use client";

import { closestCenter, DndContext, type Modifier, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type ReactNode, useId } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { sortText } from "./sortable-model";

// Pointer and touch drag for SortableList, loaded with import() (sortable-list.tsx). The keyboard is SortableList's
// own, so no KeyboardSensor here. Each row slides with --dur-enter only under motion-safe (reduced motion: no slide);
// the lifted row follows the pointer with shadow-overlay. Auto-scroll near the edges is dnd-kit's default.

/** A long press before a touch lifts a row, so a swipe still scrolls the page (a gesture threshold, not motion). */
const LONG_PRESS_MS = 250;
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** What a row gets from useSortable: the handle's ref and listeners, and whether it is lifted. */
export type DragBits = { setHandleRef: (el: HTMLElement | null) => void; listeners: Record<string, unknown> | undefined; dragging: boolean };

export function DndList({ keys, name, onMove, children }: { keys: string[]; name: (i: number) => string; onMove: (from: number, to: number) => void; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: LONG_PRESS_MS, tolerance: 8 } }),
  );
  const at = (id: unknown) => keys.indexOf(String(id));
  const n = keys.length;
  return (
    <DndContext id={useId()} sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]}
      onDragEnd={({ active, over }) => { if (over && over.id !== active.id) onMove(at(active.id), at(over.id)); }}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => sortText.lifted(name(at(active.id)), at(active.id), n),
          onDragOver: ({ active, over }) => (over ? sortText.moved(name(at(active.id)), at(over.id), n) : undefined),
          onDragEnd: ({ active, over }) => sortText.dropped(name(at(active.id)), at(over?.id ?? active.id), n),
          onDragCancel: ({ active }) => sortText.cancelled(name(at(active.id)), at(active.id), n),
        },
      }}>
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    </DndContext>
  );
}

export function DndItem({ id, disabled, wholeRow, lifted, className, children }: {
  id: string; disabled: boolean; wholeRow: boolean; lifted: boolean; className?: string; children: (bits: DragBits) => ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform: t, isDragging } = useSortable({ id, disabled, transition: null });
  const up = isDragging || lifted;
  return (
    <li ref={setNodeRef} {...(wholeRow && !disabled ? listeners : {})} style={t ? { transform: `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` } : undefined}
      className={cn(className, isDragging ? "cursor-grabbing" : "motion-safe:transition-transform motion-safe:duration-(--dur-enter)", up && "relative z-10 shadow-overlay")}>
      {children({ setHandleRef: setActivatorNodeRef, listeners, dragging: isDragging })}
    </li>
  );
}
