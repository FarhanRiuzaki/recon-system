"use client";

// The designer's centre (spec 2026-11-26 "Designer UX"): the report as the file will be, on real rows of the preview
// date (the API renders them: preview = file). The sections in the file as chips (Data only turns all off), the rows'
// filters, the Group by zone, then title, header block, the table (headers drag to reorder, fields drop in), the
// footer; Text shows the file line by line with a ruler, PDF a page.
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useState } from "react";
import type { ReportColumn, ReportSpec } from "@starterkit/shared/contracts/reports";
import { FILTER_OPS, type FilterOp } from "@starterkit/shared/reports";
import { DropZone, type ListedField, Notice, ScrollFade, SwitchRow, ToggleChips, TypeBadge } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, CloseIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { DragItem } from "./data-pane";
import type { Placement } from "./drop-model";
import { dayText, refLabel } from "./report-text";
import { addGroup, dataOnly, removeGroup, type SectionKey, sectionOn, toggleSection, toggleSummary } from "./spec-model";
import type { Preview } from "./use-reports";

export type Selected = { kind: "column"; id: string } | { kind: "section"; key: "title" | "header" | "footer" } | { kind: "report" };
export type DropMark = { columnId: string; at: Placement } | { end: true } | null;

export const OP_LABEL: Record<FilterOp, string> = { is: "is", is_not: "is not", any_of: "is any of", contains: "contains", empty: "is empty", not_empty: "isn't empty", gt: "is more than", lt: "is less than" };
const SECTION_LABEL: Record<SectionKey, string> = { title: "Title", header: "Header block", columnHeaders: "Column headers", totals: "Totals", footer: "Footer" };

type Props = {
  spec: ReportSpec; change: (fn: (s: ReportSpec) => ReportSpec, said?: string) => void; readOnly: boolean;
  preview: { data: Preview | null; error: string | null; loading: boolean }; date: string;
  fields: Map<string, ListedField>; selected: Selected; select: (s: Selected) => void; drop: DropMark; dragging: DragItem | null;
  onAddField: (f: ListedField) => void;
};

function HeaderCell({ c, i, spec, selected, select, drop, problem, fields, readOnly }: {
  c: ReportColumn; i: number; spec: ReportSpec; selected: boolean; select: () => void; drop: DropMark; problem?: string; fields: Map<string, ListedField>; readOnly: boolean;
}) {
  const drag = useDraggable({ id: `column:${c.id}`, data: { kind: "column", id: c.id, label: c.header } satisfies DragItem, disabled: readOnly });
  const over = useDroppable({ id: `col:${c.id}`, data: { columnId: c.id } });
  const mark = drop && "columnId" in drop && drop.columnId === c.id ? drop.at : null;
  const type = c.content.kind === "field" ? fields.get(c.content.ref)?.type ?? "text" : c.content.kind === "formula" ? "formula" : c.content.kind === "rownum" ? "number" : "text";
  const source = c.content.kind === "field" ? refLabel(c.content.ref, fields) : c.content.kind === "formula" ? "Formula" : c.content.kind === "rownum" ? "Row number" : "Fixed text";
  // the second line says what fills the column; when it reads as the header, the badge alone says the type
  const sameAsHeader = source.trim().toLowerCase() === c.header.trim().toLowerCase();
  return (
    <th ref={(n) => { drag.setNodeRef(n); over.setNodeRef(n); }} scope="col" aria-sort="none"
      className={cn("relative border-b border-line bg-inset p-0 text-left align-bottom font-medium whitespace-nowrap", drag.isDragging && "opacity-40")}>
      {mark === "before" && <span aria-hidden="true" className="absolute inset-y-1 -left-0.5 z-10 w-0.5 rounded-full bg-edit-ink" />}
      {mark === "after" && <span aria-hidden="true" className="absolute inset-y-1 -right-0.5 z-10 w-0.5 rounded-full bg-edit-ink" />}
      <button type="button" {...drag.attributes} {...drag.listeners} onClick={select} aria-pressed={selected}
        aria-label={`Column ${i + 1}: ${c.header || "no heading"}. Press to change it; drag to move it.`}
        className={cn("grid w-full min-w-24 gap-0.5 rounded-t-sm px-2.5 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-edit-ink",
          c.layout.align === "r" && "justify-items-end text-right", selected && "bg-edit-soft ring-2 ring-edit-ink ring-inset", mark === "replace" && "bg-edit-soft",
          !readOnly && "cursor-grab active:cursor-grabbing")}>
        <span className="flex max-w-56 items-center gap-2">
          <TypeBadge type={type} />
          <span className={cn("min-w-0 truncate text-body-sm text-fg", !spec.sections.columnHeaders && "text-fg-3 line-through")}>{c.header || "No heading"}</span>
        </span>
        {!sameAsHeader && <span className="max-w-56 truncate text-caption font-normal text-fg-3">{source}</span>}
        {problem && <span className="text-caption font-normal whitespace-normal text-down-ink">{problem}</span>}
      </button>
    </th>
  );
}

function EndCell({ fields, onAdd, readOnly, active, empty }: { fields: Map<string, ListedField>; onAdd: (f: ListedField) => void; readOnly: boolean; active: boolean; empty: boolean }) {
  const { setNodeRef } = useDroppable({ id: "end" });
  if (empty) return (
    <div ref={setNodeRef} className={cn("grid place-items-center gap-1 rounded-ctl border-2 border-dashed px-4 py-10 text-center text-body-sm", active ? "border-edit-ink bg-edit-soft text-edit-ink" : "border-line-strong text-fg-3")}>
      <span className="text-label text-fg">No columns yet</span>
      Drag a field from Data here, or press + beside a field.
    </div>
  );
  return (
    <th ref={setNodeRef} className={cn("w-40 border-b border-line bg-inset px-2 align-middle", active && "bg-edit-soft")}>
      <Select aria-label="Add a column" value="" disabled={readOnly} onChange={(e) => { const f = fields.get(e.target.value); if (f) onAdd(f); }} className="h-8 text-body-sm">
        <option value="">+ Add a column</option>
        {[...fields.values()].map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
      </Select>
    </th>
  );
}

function GroupZone({ spec, change, fields, readOnly, dragging }: Pick<Props, "spec" | "change" | "fields" | "readOnly" | "dragging">) {
  const { setNodeRef, isOver } = useDroppable({ id: "group" });
  return (
    <DropZone ref={setNodeRef} active={isOver && dragging?.kind === "field"} label="Group by">
      {spec.groups.length ? spec.groups.map((g, i) => (
        <span key={g} className="inline-flex items-center gap-1 rounded-full border border-line bg-inset py-0.5 pr-0.5 pl-2.5 text-body-sm text-fg">
          {i ? "then " : ""}{refLabel(g, fields)}
          {!readOnly && <Button type="button" variant="remove" size="icon-sm" aria-label={`Stop grouping by ${refLabel(g, fields)}`} onClick={() => change((s) => removeGroup(s, i), `Stopped grouping by ${refLabel(g, fields)}`)}><Icon icon={CloseIcon} className="size-3.5" /></Button>}
        </span>
      )) : <span>drag a field here to group the rows and add subtotals</span>}
      {spec.groups.length > 0 && <div className="ml-auto"><SwitchRow checked={spec.summaryOnly} disabled={readOnly} label="Summary only" description="One row per group with its totals"
        onChange={() => change(toggleSummary, spec.summaryOnly ? "Detail rows are back" : "Summary only: one row per group with its totals")} /></div>}
      {!readOnly && !spec.groups.length && (
        <Select aria-label="Group by a field" value="" className="h-8 w-full text-body-sm sm:ml-auto sm:w-44" onChange={(e) => { const f = fields.get(e.target.value); if (f) change((s) => addGroup(s, f.ref), `Grouped by ${f.label}`); }}>
          <option value="">or pick a field</option>
          {[...fields.values()].map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
        </Select>
      )}
    </DropZone>
  );
}

function RowsBar({ spec, change, fields, readOnly, count, date }: Pick<Props, "spec" | "change" | "fields" | "readOnly"> & { count: number | null; date: string }) {
  const [adding, setAdding] = useState<{ ref: string; op: FilterOp; value: string } | null>(null);
  const valueless = (op: FilterOp) => op === "empty" || op === "not_empty";
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-body-sm text-fg-3">Rows:</span>
        {!spec.rows.filters.length && <span className="text-body-sm text-fg-2">every row</span>}
        {spec.rows.filters.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-card py-0.5 pr-0.5 pl-2.5 text-body-sm">
            <b className="font-medium">{refLabel(f.ref, fields)}</b> {OP_LABEL[f.op]} {!valueless(f.op) && <b className="font-medium">{f.value.join(", ")}</b>}
            {!readOnly && <Button type="button" variant="remove" size="icon-sm" aria-label="Remove this filter" onClick={() => change((s) => ({ ...s, rows: { filters: s.rows.filters.filter((_, k) => k !== i) } }), "Filter removed")}><Icon icon={CloseIcon} className="size-3.5" /></Button>}
          </span>
        ))}
        {!readOnly && !adding && <Button type="button" variant="create" size="sm" onClick={() => setAdding({ ref: [...fields.keys()][0] ?? "", op: "any_of", value: "" })}><Icon icon={AddIcon} />Add filter</Button>}
        <span className="ml-auto text-body-sm text-fg-3 tabular-nums">{count === null ? "Loading rows…" : `${count} ${count === 1 ? "row" : "rows"} on ${dayText(date)} in the preview`}</span>
      </div>
      {adding && (
        <form className="flex flex-wrap items-end gap-2 rounded-ctl border border-line bg-inset p-2" onSubmit={(e) => {
          e.preventDefault();
          const value = valueless(adding.op) ? [] : adding.op === "any_of" ? adding.value.split(",").map((v) => v.trim()).filter(Boolean) : [adding.value.trim()];
          if (!adding.ref || (!valueless(adding.op) && !value.length)) return;
          change((s) => ({ ...s, rows: { filters: [...s.rows.filters, { ref: adding.ref, op: adding.op, value }] } }), "Filter added");
          setAdding(null);
        }}>
          <Select aria-label="Field" className="w-full sm:w-44" value={adding.ref} onChange={(e) => setAdding({ ...adding, ref: e.target.value })}>
            {[...fields.values()].map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
          </Select>
          <Select aria-label="Condition" className="w-full sm:w-36" value={adding.op} onChange={(e) => setAdding({ ...adding, op: e.target.value as FilterOp })}>
            {FILTER_OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </Select>
          {!valueless(adding.op) && <Input aria-label="Value" className="w-full sm:w-48" value={adding.value} placeholder={adding.op === "any_of" ? "unmatch, matched_late" : "Value"} onChange={(e) => setAdding({ ...adding, value: e.target.value })} />}
          <Button type="submit" variant="create" size="sm"><Icon icon={AddIcon} />Add</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(null)}>Cancel</Button>
        </form>
      )}
    </div>
  );
}

const lineClass = { row: "", group: "bg-tray font-semibold", subtotal: "bg-inset font-semibold", total: "border-t-2 border-line-strong bg-inset font-semibold" } as const;

export function ReportCanvas(p: Props) {
  const { spec, change, readOnly, preview, selected, select, fields, drop, dragging } = p;
  const fmt = spec.output.format;
  const flat = fmt === "csv" || fmt === "txt";
  const keys: SectionKey[] = flat ? ["header", "columnHeaders", "totals", "footer"] : ["title", "header", "columnHeaders", "totals", "footer"];
  const data = preview.data;
  const problemOf = new Map((data?.problems ?? []).map((x) => [x.columnId, x.message.replace(/^[^:]*: /, "")]));
  const idx = new Map((data?.columns ?? []).map((c, i) => [c.id, i]));
  const band = (key: "title" | "header" | "footer", label: string, body: React.ReactNode) => (
    <button type="button" onClick={() => select({ kind: "section", key })} aria-pressed={selected.kind === "section" && selected.key === key} aria-label={`${label}: press to change it`}
      className={cn("group relative w-full rounded-ctl border border-dashed border-transparent px-3 py-2 text-left hover:border-line-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-edit-ink",
        selected.kind === "section" && selected.key === key && "border-solid border-edit-ink bg-edit-soft")}>
      <span className="absolute -top-2.5 left-3 bg-card px-1.5 text-caption text-fg-3 opacity-0 group-hover:opacity-100 group-aria-pressed:opacity-100">{label}</span>
      {body}
    </button>
  );
  const table = (
    <ScrollFade focusable aria-label="The report's columns and rows" className="rounded-ctl border border-line">
      <table className="w-full border-separate border-spacing-0 text-body-sm">
        <thead><tr>
          {spec.columns.map((c, i) => <HeaderCell key={c.id} c={c} i={i} spec={spec} selected={selected.kind === "column" && selected.id === c.id} select={() => select({ kind: "column", id: c.id })}
            drop={drop} problem={problemOf.get(c.id)} fields={fields} readOnly={readOnly} />)}
          <EndCell fields={fields} onAdd={p.onAddField} readOnly={readOnly} active={!!drop && "end" in drop} empty={false} />
        </tr></thead>
        <tbody>
          {(data?.lines ?? []).map((l, r) => (
            <tr key={r} className={lineClass[l.kind]}>
              {spec.columns.map((c) => {
                const i = idx.get(c.id);
                const v = i === undefined ? "…" : l.cells[i] ?? "";
                const mark = i === undefined ? null : l.marks[i];
                return <td key={c.id} onClick={() => select({ kind: "column", id: c.id })}
                  className={cn("border-b border-line px-2.5 py-1.5 whitespace-nowrap tabular-nums", c.layout.align === "r" && "text-right", c.layout.align === "c" && "text-center",
                    selected.kind === "column" && selected.id === c.id && "bg-row-selected", mark === "red" && "font-semibold text-down-ink", mark === "bold" && "font-semibold")}>{v}</td>;
              })}
              <td className="border-b border-line" />
            </tr>
          ))}
          {data && !data.lines.length && <tr><td colSpan={spec.columns.length + 1} className="px-3 py-6 text-center text-fg-3">No rows on {dayText(p.date)} match. Pick another preview date, or change the filters.</td></tr>}
        </tbody>
      </table>
    </ScrollFade>
  );
  const ruler = (n: number) => Array.from({ length: n }, (_, i) => ((i + 1) % 10 === 0 ? String(((i + 1) / 10) % 10) : (i + 1) % 5 === 0 ? "+" : "·")).join("");
  const width = spec.columns.reduce((a, c) => a + c.layout.width, 0);
  const sheet = data?.sheet;
  const body = (
    <div className="grid min-w-0 grid-cols-1 gap-list">
      {!flat && spec.sections.title.on && band("title", "Title", <span className="text-heading-sm font-semibold text-fg">{sheet?.title ?? spec.sections.title.text}</span>)}
      {spec.sections.header.on && band("header", flat ? "Header block (the file's first lines)" : "Header block",
        sheet?.header?.length ? <span className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-x-4 gap-y-1 text-body-sm">{sheet.header.map((h, i) => <span key={i}><span className="text-fg-3">{h.label}</span> {h.value}</span>)}</span>
          : <span className="text-body-sm text-fg-3">No lines yet. Press to add a label and value.</span>)}
      <GroupZone spec={spec} change={change} fields={fields} readOnly={readOnly} dragging={dragging} />
      {spec.columns.length ? table : <EndCell fields={fields} onAdd={p.onAddField} readOnly={readOnly} active={!!drop && "end" in drop} empty />}
      {!spec.sections.columnHeaders && spec.columns.length > 0 && <p className="text-caption text-fg-3">Column headers are off: the struck-through row is here only so you can change the columns.</p>}
      {fmt === "txt" && data?.text && (
        <div className="grid gap-1">
          <span className="text-caption font-semibold tracking-wide text-fg-3 uppercase">The file, line by line · {width} characters per line</span>
          <ScrollFade focusable aria-label="The file, line by line" className="rounded-ctl border border-line bg-inset"><pre className="w-max px-3 py-2 font-mono text-mono leading-relaxed"><span className="text-fg-4">{ruler(width)}</span>{"\n"}{data.text.join("\n")}</pre></ScrollFade>
        </div>
      )}
      {spec.sections.footer.on && band("footer", flat ? "Footer (the file's last line)" : "Footer",
        <span className="flex flex-wrap justify-between gap-2 text-body-sm text-fg-3"><span>{sheet?.footer?.text || (flat ? "No text: no last line." : "")} {!flat && sheet?.footer?.stamp ? <b className="ml-1 rounded-sm border border-healthy-mark px-1.5 text-caption text-healthy-ink">{sheet.footer.stamp}</b> : null}</span>
          {!flat && spec.sections.footer.pageNumbers && <span>Page 1 of 1</span>}</span>)}
    </div>
  );
  return (
    <div className="grid min-w-0 grid-cols-1 gap-list">
      <ToggleChips label="In the file" items={keys.map((k) => ({ key: k, label: SECTION_LABEL[k], on: sectionOn(spec, k) }))} onToggle={(k) => !readOnly && change((s) => toggleSection(s, k))}
        extra={!readOnly && <Button type="button" variant="ghost" size="sm" onClick={() => change(dataOnly, "Data only: just the rows, nothing above or below")}>Data only</Button>} />
      {flat && <Notice tone="info">{fmt === "csv" ? "CSV holds the rows: the header block's lines come first, the footer's text last." : "Every line is the columns side by side at their widths; set a column's width and padding on the right."}</Notice>}
      <RowsBar spec={spec} change={change} fields={fields} readOnly={readOnly} count={data ? data.rows : null} date={p.date} />
      {preview.error && <Notice tone="warn">The preview didn&apos;t load: {preview.error}</Notice>}
      {(data?.problems ?? []).filter((x) => !x.columnId).map((x) => <Notice key={x.message} tone="warn">{x.message}</Notice>)}
      {fmt === "pdf" ? <div className="min-w-0 rounded-sm border border-line-strong bg-card p-card shadow-xs md:p-6">{body}</div> : body}
    </div>
  );
}
