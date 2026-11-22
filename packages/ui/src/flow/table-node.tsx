"use client";

// An ERD table on a canvas (owner 22 Nov: "seperti setup ERD … ditarik dari ujung ke ujung"): a card with a header
// (title, caption, row count) and one row per field. A row that takes a connection has a handle on the table's side —
// right on a source table, left on a target — so a line is drawn from the end of one row to the end of another. A row
// says its state in words as well as colour: required (red *), not mapped, fixed, auto generated, mapped. The card
// doesn't clip (overflow stays visible): a handle sits half outside its edge and must take the press there.
import "@xyflow/react/dist/base.css";
import "./flow.css";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { memo } from "react";
import { cn } from "../lib/cn";

export type TableRow = {
  id: string; label: string;
  /** A group heading (an object of the request): no handle, its fields indented under it. */
  header?: boolean;
  depth?: number; required?: boolean;
  /** missing = required and nothing fills it; fixed / auto = the far side fills it itself; mapped = a source is set. */
  state?: "missing" | "fixed" | "auto" | "mapped" | null;
  /** A short word on the right: "Fixed", "Auto generated", a fixed value, the source of a template. */
  note?: string;
  connectable: boolean; selected?: boolean;
  /** Its data type ("text", "amount", "numeric") and a limit ("≤ 34"), shown as a chip at the row's end. */
  type?: string; limit?: string;
  /** A value from a real break (sources) or what would be sent (request); a state's note takes its place. */
  example?: string;
};
export type TableCardProps = {
  title: string; caption?: string | null; side: "source" | "target"; rows: readonly TableRow[];
  /** A row chosen (click or Enter): the inspector opens it. */
  onRowSelect?: (id: string) => void;
};

const NOTE: Record<NonNullable<TableRow["state"]>, string> = { missing: "Not mapped", fixed: "Fixed", auto: "Auto generated", mapped: "" };

export function TableCard({ title, caption, side, rows, onRowSelect }: TableCardProps) {
  const fields = rows.filter((r) => !r.header).length;
  return (
    <div data-slot="table-node" role="group" aria-label={title} className="w-80 rounded-lg border border-line-strong bg-card shadow-sm">
      <div className="flex items-start justify-between gap-2 rounded-t-lg border-b border-line-strong bg-tray px-3 py-2">
        <span className="grid min-w-0">
          <span className="truncate text-label text-fg">{title}</span>
          {caption && <span className="truncate text-caption text-fg-3">{caption}</span>}
        </span>
        <span className="shrink-0 rounded-full bg-card px-1.5 text-caption text-fg-3 tabular ring-1 ring-line">{fields}</span>
      </div>
      <ul className="divide-y divide-line [&>li:last-child]:rounded-b-lg">
        {rows.map((r) => {
          const note = r.note ?? (r.state ? NOTE[r.state] : "");
          return (
            <li key={r.id} data-row={r.id} aria-current={r.selected || undefined}
              className={cn("relative flex h-8 items-center gap-2 pr-3 text-body-sm", side === "source" ? "pl-3" : "pl-4",
                r.header ? "bg-tray/60 text-fg-2" : "text-fg",
                r.selected && "bg-primary-soft", r.state === "missing" && !r.selected && "bg-down-soft/40",
                (r.state === "fixed" || r.state === "auto") && "text-fg-3",
                onRowSelect && !r.header && "cursor-pointer hover:bg-tray")}
              onClick={onRowSelect && !r.header ? () => onRowSelect(r.id) : undefined}>
              <span className="flex min-w-0 flex-1 items-center" style={{ paddingLeft: `${(r.depth ?? 0) * 14}px` }}>
                <span className={cn("truncate", side === "target" && "font-mono")}>
                  {r.label}{r.required && <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>}
                </span>
                {r.required && <span className="sr-only"> (required)</span>}
              </span>
              {note ? <span className={cn("max-w-28 shrink-0 truncate text-caption", r.state === "missing" ? "text-down-ink" : "text-fg-3")}>{note}</span>
                : r.example !== undefined && <span className="max-w-28 shrink-0 truncate font-mono text-caption text-fg-3" title={r.example}>{r.example}</span>}
              {(r.type || r.limit) && !r.header && (
                <span className="shrink-0 rounded-sm bg-tray px-1.5 font-mono text-caption text-fg-3 ring-1 ring-line">{[r.limit, r.type].filter(Boolean).join(" ")}</span>
              )}
              {r.connectable && (
                <Handle id={r.id} type={side} position={side === "source" ? Position.Right : Position.Left}
                  className={cn("flow-port", r.state === "mapped" && "is-on", r.state === "missing" && "is-missing")} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export type TableNodeType = Node<TableCardProps, "table">;
/** The card as a React Flow node (`nodeTypes={{ table: TableNode }}`). */
export const TableNode = memo(({ data }: NodeProps<TableNodeType>) => <TableCard {...data} />);
TableNode.displayName = "TableNode";
