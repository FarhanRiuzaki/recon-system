"use client";

// The designer's Data pane (spec 2026-11-26 "Designer UX"): which data the report reads (the recon's results, items
// or daily recap), its fields grouped by where they come from (each side's source record holds every attribute), and
// "Build your own" columns. Every field drags into the report, or its + adds it at the end.
import { useDraggable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ReportFieldsDto } from "@starterkit/shared/contracts/reports";
import type { ReportDataset } from "@starterkit/shared/reports";
import { Field, FieldList, type ListedField, Panel, TypeBadge } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon } from "@starterkit/ui/ui/icons";
import { Select } from "@starterkit/ui/ui/select";
import { Skeleton } from "@starterkit/ui/ui/skeleton";

export const DATASET_LABEL: Record<ReportDataset, string> = { results: "Results", items: "Every item", recap: "Daily recap" };
export const SPECIALS = [{ kind: "formula", label: "Formula", type: "formula" }, { kind: "text", label: "Fixed text", type: "text" }, { kind: "rownum", label: "Row number", type: "number" }] as const;
export type Special = (typeof SPECIALS)[number]["kind"];

/** A drag's payload: a field of the data, a "Build your own" column, or a column of the report being moved. */
export type DragItem = { kind: "field"; field: ListedField } | { kind: "special"; special: Special; label: string } | { kind: "column"; id: string; label: string };

function Draggable({ id, item, children, disabled }: { id: string; item: DragItem; children: ReactNode; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: item, disabled });
  return <div ref={setNodeRef} {...attributes} {...listeners} aria-roledescription="draggable field" className={isDragging ? "opacity-40" : "cursor-grab active:cursor-grabbing"}>{children}</div>;
}

export function DataPane({ dataset, onDataset, fields, used, onAdd, onAddSpecial, readOnly, open, onOpenChange }: {
  open: boolean; onOpenChange: (open: boolean) => void; dataset: ReportDataset; onDataset: (d: ReportDataset) => void; fields: ReportFieldsDto | undefined; used: Set<string>;
  onAdd: (f: ListedField) => void; onAddSpecial: (k: Special) => void; readOnly: boolean;
}) {
  const [q, setQ] = useState("");
  const groups = (fields?.groups ?? []).map((g) => ({ label: g.label, fields: g.fields.map((f): ListedField => ({ ...f, used: used.has(f.ref) })) }));
  const byRef = new Map(groups.flatMap((g) => g.fields.map((f) => [f.ref, f] as const)));
  return (
    <Panel title="Data" description="Drag into the report, or press +." bodyClassName="grid min-w-0 grid-cols-1 gap-list" collapsible={{ open, onOpenChange, what: "fields" }}>
      <Field id="designer-dataset" label="Rows from">
        <Select id="designer-dataset" value={dataset} disabled={readOnly} onChange={(e) => onDataset(e.target.value as ReportDataset)}>
          {(Object.keys(DATASET_LABEL) as ReportDataset[]).map((d) => <option key={d} value={d}>{DATASET_LABEL[d]}</option>)}
        </Select>
      </Field>
      {fields ? (
        <FieldList groups={groups} query={q} onQuery={setQ} onAdd={(ref) => { const f = byRef.get(ref); if (f && !readOnly) onAdd(f); }}
          wrap={(f, row) => <Draggable id={`field:${f.ref}`} item={{ kind: "field", field: f }} disabled={readOnly}>{row}</Draggable>} />
      ) : <div className="grid gap-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>}
      {dataset !== "recap" && (
        <section className="grid min-w-0 grid-cols-1 gap-0.5">
          <h3 className="mt-2 px-1 text-caption font-semibold tracking-wide text-fg-3 uppercase">Build your own</h3>
          {SPECIALS.map((s) => (
            <Draggable key={s.kind} id={`special:${s.kind}`} item={{ kind: "special", special: s.kind, label: s.label }} disabled={readOnly}>
              <div className="group flex min-h-8 items-center gap-2 rounded-sm border border-transparent px-2 py-1 hover:border-line hover:bg-inset">
                <TypeBadge type={s.type} />
                <span className="min-w-0 flex-1 text-body-sm">{s.label}</span>
                <Button type="button" variant="create" size="icon-sm" aria-label={`Add a ${s.label.toLowerCase()} column`} disabled={readOnly} onClick={() => onAddSpecial(s.kind)}>
                  <Icon icon={AddIcon} className="size-3.5" />
                </Button>
              </div>
            </Draggable>
          ))}
        </section>
      )}
    </Panel>
  );
}
