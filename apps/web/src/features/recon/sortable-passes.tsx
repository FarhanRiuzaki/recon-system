"use client";

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useId } from "react";
import { PassRow, type PassRowProps } from "./pass-row";

// The drag order of the passes (BUILDER-SPEC "Keyboard"): dnd-kit with its keyboard sensor. Loaded by the builder
// with import() only when a draft has two passes or more, so it stays out of the route's first load (AGENTS §9);
// until it arrives the same rows render without drag (pass-row.tsx), and Alt+↑/↓ already works.

function SortableRow(p: PassRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform: t, isDragging } = useSortable({ id: p.id });
  return (
    <PassRow {...p} sortable={{
      setNodeRef, setActivatorNodeRef, handle: { ...attributes, ...listeners }, dragging: isDragging,
      style: t ? { transform: `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)` } : undefined,
    }} />
  );
}

/** The passes as a sortable `<ol>`; a drop calls `onMove(from, to)`. dnd-kit announces each step, the drop as "Moved to pass n". */
export function SortablePasses({ rows, onMove }: { rows: PassRowProps[]; onMove: (from: number, to: number) => void }) {
  const keys = rows.map((r) => r.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const at = (id: unknown) => keys.indexOf(String(id)) + 1;
  return (
    <DndContext id={useId()} sensors={sensors} collisionDetection={closestCenter}
      onDragEnd={({ active, over }: DragEndEvent) => { if (over) onMove(keys.indexOf(String(active.id)), keys.indexOf(String(over.id))); }}
      accessibility={{
        screenReaderInstructions: { draggable: "To move a pass, press Space or Enter, move it with the arrow keys, then press Space or Enter to drop it, or Escape to cancel." },
        announcements: {
          onDragStart: ({ active }) => `Picked up pass ${at(active.id)}.`,
          onDragOver: ({ over }) => (over ? `Over position ${at(over.id)}.` : undefined),
          onDragEnd: ({ over }) => (over ? `Moved to pass ${at(over.id)}` : "Dropped where it was."),
          onDragCancel: () => "Move cancelled.",
        },
      }}>
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <ol aria-label="Passes in run order" className="grid">{rows.map((r) => <SortableRow key={r.id} {...r} />)}</ol>
      </SortableContext>
    </DndContext>
  );
}
