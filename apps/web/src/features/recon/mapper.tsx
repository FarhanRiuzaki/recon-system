"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Combobox } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { CatalogField } from "@starterkit/shared/conditions";
import type { OpField } from "@starterkit/shared/integrations";
import type { Source } from "@starterkit/shared/mapping";
import { type Leaf, requestLeaves } from "./actions-model";
import { ChangeChips } from "./change-chips";

// The field mapper (design §4.5, owner 22 Nov: "kiri data recon, kanan kolom openapi, tinggal tarik garis"): the
// recon's fields on the left, the operation's request fields on the right. Pick a left field, then a right one, to
// connect them (a line is drawn between them on a wide screen); pick a right field to set its source in words: a field
// with changes, a fixed value, a template, a lookup or a named account. Keyboard and touch never need to drag.

const GROUP = { break: "Unmatch item", recon: "Recon", side_a: "Side A", side_b: "Side B", approval: "Approval" } as const;
type Setup = { accounts: readonly { key: string; label: string }[]; lookups: readonly { name: string }[] };
type Op = { request: readonly OpField[]; fixed: readonly string[]; auto: readonly string[] };
const KIND_LABEL = { field: "From a field", const: "Fixed value", template: "Template", lookup: "Lookup", account: "Account" } as const;

/** A source in a few words, for a request field's row. */
export function sourceText(s: Source | undefined, catalog: readonly CatalogField[]): string {
  if (!s) return "Not mapped";
  const label = (k: string) => catalog.find((f) => f.key === k)?.label ?? k;
  if (s.kind === "field") return `${label(s.key)}${s.transforms.length ? ` · ${s.transforms.join(", ")}` : ""}`;
  if (s.kind === "const") return `“${s.value}”`;
  if (s.kind === "template") return s.text;
  if (s.kind === "lookup") return `${s.table}[${sourceText(s.key, catalog)}]${s.fallback !== undefined ? ` or “${s.fallback}”` : ""}`;
  return `Account ${s.account} · ${s.part}`;
}

function SourceEditor({ path, value, onChange, catalog, setup, disabled }: { path: string; value: Source | undefined; onChange: (s: Source | undefined) => void; catalog: readonly CatalogField[]; setup: Setup; disabled: boolean }) {
  const kind = value?.kind ?? "none";
  const fieldPick = (v: string | undefined, set: (k: string) => void, label: string) => (
    <Combobox label={label} value={v ? [v] : []} disabled={disabled} placeholder="Pick a field" searchPlaceholder="Search fields"
      options={catalog.map((f) => ({ value: f.key, label: f.label, group: GROUP[f.group] }))} onValueChange={([k]) => k && set(k)} />
  );
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-card p-3 motion-safe:animate-enter">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label text-fg">{path}</span>
        <Select aria-label={`${path}: where its value comes from`} value={kind} disabled={disabled} className="h-8 w-40"
          onChange={(e) => {
            const k = e.target.value;
            onChange(k === "field" ? { kind: "field", key: catalog[0]?.key ?? "break.amount", transforms: [] } : k === "const" ? { kind: "const", value: "" } : k === "template" ? { kind: "template", text: "" }
              : k === "lookup" ? { kind: "lookup", table: setup.lookups[0]?.name ?? "", key: { kind: "field", key: catalog[0]?.key ?? "break.amount", transforms: [] } }
                : k === "account" ? { kind: "account", account: setup.accounts[0]?.key ?? "", part: "number" } : undefined);
          }}>
          <option value="none">Not mapped</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k} disabled={(k === "lookup" && !setup.lookups.length) || (k === "account" && !setup.accounts.length)}>{l}</option>)}
        </Select>
      </span>
      {value?.kind === "field" && (
        <div className="grid gap-2 md:grid-cols-2">
          {fieldPick(value.key, (key) => onChange({ ...value, key }), `${path}: field`)}
          <ChangeChips label={`${path}: changes`} value={value.transforms} disabled={disabled} onChange={(transforms) => onChange({ ...value, transforms })} />
        </div>
      )}
      {value?.kind === "const" && <Input aria-label={`${path}: fixed value`} value={value.value} disabled={disabled} maxLength={500} className="h-8" onChange={(e) => onChange({ ...value, value: e.target.value })} />}
      {value?.kind === "template" && (
        <Input aria-label={`${path}: template`} value={value.text} disabled={disabled} maxLength={500} className="h-8 font-mono" placeholder="{side_a.attrs.e2e_id}{accounts.suspense.number}{break.business_date|date:yyMMdd}"
          onChange={(e) => onChange({ ...value, text: e.target.value })} />
      )}
      {value?.kind === "lookup" && (
        <div className="grid gap-2 md:grid-cols-3">
          <Select aria-label={`${path}: lookup table`} value={value.table} disabled={disabled} className="h-8" onChange={(e) => onChange({ ...value, table: e.target.value })}>
            {setup.lookups.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
          </Select>
          {fieldPick(value.key.kind === "field" ? value.key.key : undefined, (key) => onChange({ ...value, key: { kind: "field", key, transforms: [] } }), `${path}: lookup key`)}
          <Input aria-label={`${path}: when not found`} value={value.fallback ?? ""} disabled={disabled} placeholder="When not found (optional)" className="h-8"
            onChange={(e) => { const { fallback: _, ...rest } = value; onChange(e.target.value ? { ...rest, fallback: e.target.value } : rest); }} />
        </div>
      )}
      {value?.kind === "account" && (
        <div className="grid gap-2 md:grid-cols-2">
          <Select aria-label={`${path}: account`} value={value.account} disabled={disabled} className="h-8" onChange={(e) => onChange({ ...value, account: e.target.value })}>
            {setup.accounts.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </Select>
          <Select aria-label={`${path}: account part`} value={value.part} disabled={disabled} className="h-8" onChange={(e) => onChange({ ...value, part: e.target.value as "number" | "label" | "currency" })}>
            <option value="number">Number</option><option value="label">Name</option><option value="currency">Currency</option>
          </Select>
        </div>
      )}
    </div>
  );
}

/** The mapper of one variant: `mapping` (request path → source) over the operation `op`. */
export function Mapper({ mapping, onChange, op, catalog, setup, disabled }: {
  mapping: Readonly<Record<string, Source>>; onChange: (m: Record<string, Source>) => void; op: Op; catalog: readonly CatalogField[]; setup: Setup; disabled: boolean;
}) {
  const leaves = requestLeaves(op);
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const set = (path: string, s: Source | undefined) => { const { [path]: _, ...rest } = mapping; onChange(s ? { ...rest, [path]: s } : rest); };
  // lines between a left field and the request fields it fills (wide screens)
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ d: string; key: string }[]>([]);
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const draw = () => {
      const r = root.getBoundingClientRect();
      const out: { d: string; key: string }[] = [];
      for (const [path, s] of Object.entries(mapping)) {
        if (s.kind !== "field") continue;
        const a = root.querySelector(`[data-left="${CSS.escape(s.key)}"]`)?.getBoundingClientRect(), b = root.querySelector(`[data-right="${CSS.escape(path)}"]`)?.getBoundingClientRect();
        if (!a || !b || !a.width || !b.width) continue;
        const x1 = a.right - r.left, y1 = a.top + a.height / 2 - r.top, x2 = b.left - r.left, y2 = b.top + b.height / 2 - r.top, mx = (x1 + x2) / 2;
        out.push({ key: path, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` });
      }
      setLines(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    // the lists reflow without the box resizing (fonts, an editor opening), so watch them too
    ro.observe(root);
    root.querySelectorAll("section").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [mapping, open]);
  const used = new Set(Object.values(mapping).flatMap((s) => (s.kind === "field" ? [s.key] : [])));
  const row = (l: Leaf) => {
    const s = mapping[l.path];
    const missing = l.required && !l.filledBy && !s;
    return (
      <li key={l.path} className="grid gap-1.5">
        <button type="button" data-right={l.path} disabled={disabled && !s}
          onClick={() => { if (picked && !l.filledBy) { set(l.path, { kind: "field", key: picked, transforms: [] }); setPicked(null); } else setOpen(open === l.path ? null : l.path); }}
          className={cn("grid w-full gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary",
            missing ? "border-down-mark" : "border-line", open === l.path && "bg-tray", l.filledBy && "opacity-60")}>
          <span className="flex items-center justify-between gap-2">
            <span className="font-mono text-body-sm text-fg">{l.path}{l.required && <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>}</span>
            <span className="text-caption text-fg-3">{l.filledBy === "fixed" ? "Fixed" : l.filledBy === "auto" ? "Auto generated" : missing ? "Required" : ""}</span>
          </span>
          {!l.filledBy && <span className={cn("truncate text-caption", s ? "text-fg-2" : missing ? "text-down-ink" : "text-fg-3")}>{sourceText(s, catalog)}</span>}
        </button>
        {open === l.path && !l.filledBy && <SourceEditor path={l.path} value={s} onChange={(v) => set(l.path, v)} catalog={catalog} setup={setup} disabled={disabled} />}
      </li>
    );
  };
  return (
    <div ref={box} className="relative grid gap-4 xl:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1.3fr)] xl:gap-0">
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 hidden h-full w-full xl:block">
        {lines.map((l) => <path key={l.key} d={l.d} fill="none" className="stroke-primary" strokeWidth={1.25} opacity={0.5} />)}
      </svg>
      <section aria-label="Recon fields" className="grid grid-cols-1 content-start gap-1.5">
        <h4 className="text-label text-fg">Recon fields</h4>
        <p className="text-caption text-fg-3">{picked ? "Now pick the request field it fills." : "Pick one, then the request field it fills."}</p>
        <ul className="grid grid-cols-1 gap-1">
          {catalog.map((f) => (
            <li key={f.key}>
              <button type="button" data-left={f.key} disabled={disabled} aria-pressed={picked === f.key}
                onClick={() => setPicked(picked === f.key ? null : f.key)}
                className={cn("flex w-full items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-body-sm transition-colors duration-(--dur-fast) hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary",
                  picked === f.key ? "bg-primary-soft text-primary" : used.has(f.key) ? "text-fg" : "text-fg-2")}>
                {/* "Source · file · Field": the field first, where it comes from under it */}
                <span className="grid min-w-0">
                  <span className="truncate">{f.label.split(" · ").at(-1)}</span>
                  {f.label.includes(" · ") && <span className="truncate text-caption text-fg-3">{f.label.split(" · ").slice(0, -1).join(" · ")}</span>}
                </span>
                <span className="shrink-0 text-caption text-fg-3">{GROUP[f.group]}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {/* the lines' lane between the two lists */}
      <span aria-hidden="true" className="hidden xl:block" />
      <section aria-label="Request fields" className="grid grid-cols-1 content-start gap-1.5">
        <h4 className="text-label text-fg">Request fields</h4>
        <p className="text-caption text-fg-3">Pick one to set where its value comes from.</p>
        <ul className="grid grid-cols-1 gap-1.5">{leaves.map(row)}</ul>
      </section>
      {picked && <Button type="button" variant="ghost" size="sm" className="justify-self-start xl:col-span-3" onClick={() => setPicked(null)}>Cancel connecting</Button>}
    </div>
  );
}
