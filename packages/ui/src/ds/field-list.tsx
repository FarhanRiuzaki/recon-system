"use client";

import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { AddIcon, SearchIcon } from "../ui/icons";
import { Input } from "../ui/input";

export type FieldType = "text" | "number" | "date" | "status" | "formula";
export type ListedField = { ref: string; label: string; type: FieldType; customer: boolean; used?: boolean };

const BADGE: Record<FieldType, { text: string; cls: string }> = {
  text: { text: "Abc", cls: "bg-primary-soft text-primary-ink" },
  number: { text: "123", cls: "bg-create-soft text-create-ink" },
  date: { text: "Day", cls: "bg-degraded-soft text-degraded-ink" },
  status: { text: "●", cls: "bg-edit-soft text-edit-ink" },
  formula: { text: "ƒx", cls: "border border-dashed border-line-strong bg-inset text-fg-2" },
};

/** A field's type at a glance (designer Data pane, column headers): Abc, 123, Day, ● (a status), ƒx (a formula). */
export function TypeBadge({ type, className }: { type: FieldType; className?: string }) {
  const b = BADGE[type];
  return <span aria-hidden="true" className={cn("grid size-5 shrink-0 place-items-center rounded-sm font-mono text-[10px] font-semibold", b.cls, className)}>{b.text}</span>;
}

/**
 * The fields a designer can place (spec 2026-11-26 "Designer UX", Data pane): grouped, searchable rows with a type
 * badge, a "masked" tag on customer data and a + that adds the field (every drag has a click equivalent). `wrap`
 * lets the screen make a row draggable (its drag library stays in the feature).
 */
export function FieldList({ groups, query, onQuery, onAdd, wrap = (_, row) => row }: {
  groups: readonly { label: string; fields: readonly ListedField[] }[]; query: string; onQuery: (q: string) => void; onAdd: (ref: string) => void;
  wrap?: (f: ListedField, row: ReactNode) => ReactNode;
}) {
  const q = query.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, fields: g.fields.filter((f) => !q || f.label.toLowerCase().includes(q) || f.ref.toLowerCase().includes(q)) })).filter((g) => g.fields.length);
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Icon icon={SearchIcon} className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" />
        <Input aria-label="Search fields" placeholder="Search fields" className="pl-8" value={query} onChange={(e) => onQuery(e.target.value)} />
      </div>
      {shown.map((g) => (
        <section key={g.label} className="grid gap-0.5">
          <h3 className="mt-2 px-1 text-caption font-semibold tracking-wide text-fg-3 uppercase">{g.label}</h3>
          {g.fields.map((f) => <div key={f.ref}>{wrap(f, (
            <div className="group flex min-h-8 items-center gap-2 rounded-sm border border-transparent px-2 py-1 hover:border-line hover:bg-inset">
              <TypeBadge type={f.type} />
              <span className="min-w-0 flex-1 truncate text-body-sm">{f.label}{f.used && <span className="text-fg-4"> · In the report</span>}</span>
              {f.customer && <span className="rounded-full border border-line px-1.5 text-caption text-fg-3" title="Customer data: masked unless an official report shows it in full">masked</span>}
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Add ${f.label} as a column`} className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onAdd(f.ref)}>
                <Icon icon={AddIcon} className="size-3.5" />
              </Button>
            </div>
          ))}</div>)}
        </section>
      ))}
      {!shown.length && <p className="px-1 text-body-sm text-fg-3">{q ? `No field matches “${query.trim()}”.` : "No fields yet."}</p>}
    </div>
  );
}
