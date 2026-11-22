"use client";

import { Combobox } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { type CatalogField, type Clause, type Condition, LIST_OPS, NO_VALUE_OPS, OP_TEXT, type Op, OPS_BY_KIND } from "@starterkit/shared/conditions";

// A rule's condition as sentences (DEC-052 rev 2 §4.3, Figma 06 Rules frames): "All of" / "Any of" the clauses, each
// "field · comparison · value", the fields from the recon version's catalog (break, recon, side A, side B).

const GROUP = { break: "Break", recon: "Recon", side_a: "Side A", side_b: "Side B" } as const;
const CLAUSES_MAX = 20;
const isClause = (x: Clause | Condition): x is Clause => "field" in x;

/** One clause: the field, a comparison its kind offers, and the value (several, comma separated, for "is one of"). */
function ClauseRow({ c, catalog, onChange, onRemove, n, disabled }: {
  c: Clause; catalog: readonly CatalogField[]; onChange: (c: Clause) => void; onRemove: () => void; n: number; disabled: boolean;
}) {
  const f = catalog.find((x) => x.key === c.field);
  const ops = f ? OPS_BY_KIND[f.kind] : [];
  const list = LIST_OPS.includes(c.op);
  const shown = Array.isArray(c.value) ? c.value.join(", ") : c.value ?? "";
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-start gap-2 max-md:grid-cols-1">
      <Combobox label={`Condition ${n}: field`} value={c.field ? [c.field] : []} disabled={disabled} placeholder="Pick a field" searchPlaceholder="Search fields"
        options={[...catalog.map((x) => ({ value: x.key, label: x.label, group: GROUP[x.group] })),
          ...(c.field && !f ? [{ value: c.field, label: "A field no longer read", group: "Gone" }] : [])]}
        onValueChange={([k]) => { const nf = catalog.find((x) => x.key === k); if (nf) onChange({ field: nf.key, op: OPS_BY_KIND[nf.kind][0]!, value: "" }); }} />
      <Select aria-label={`Condition ${n}: comparison`} value={c.op} disabled={disabled || !f}
        onChange={(e) => { const op = e.target.value as Op; onChange({ ...c, op, value: NO_VALUE_OPS.includes(op) ? undefined : LIST_OPS.includes(op) ? (Array.isArray(c.value) ? c.value : c.value ? [c.value] : []) : Array.isArray(c.value) ? c.value[0] ?? "" : c.value ?? "" }); }}>
        {(ops.length ? ops : [c.op]).map((o) => <option key={o} value={o}>{OP_TEXT[o]}</option>)}
      </Select>
      {NO_VALUE_OPS.includes(c.op) ? <span /> : (
        <Input aria-label={`Condition ${n}: value`} value={shown} disabled={disabled} maxLength={500}
          placeholder={list ? "Values, comma separated" : f?.kind === "money" ? "Amount in minor units, e.g. 2500000000" : f?.kind === "date" ? "YYYY-MM-DD" : "Value"}
          onChange={(e) => onChange({ ...c, value: list ? e.target.value.split(",").map((v) => v.trim()).filter((v, i, a) => v || i === a.length - 1) : e.target.value })} />
      )}
      {!disabled && <Button type="button" variant="ghost" size="icon" aria-label={`Remove condition ${n}`} onClick={onRemove}><Icon icon={CloseIcon} /></Button>}
    </div>
  );
}

/**
 * Edits the top level of a condition: all or any of its clauses. A nested group (set through the API) is kept as it
 * is and shown as text.
 */
export function ConditionEditor({ value, onChange, catalog, disabled, label }: {
  value: Condition; onChange: (c: Condition) => void; catalog: readonly CatalogField[]; disabled: boolean; label: string;
}) {
  const mode = "all" in value ? "all" : "any";
  const parts = "all" in value ? value.all : value.any;
  const set = (next: (Clause | Condition)[]) => onChange(mode === "all" ? { all: next } : { any: next });
  return (
    <fieldset className="grid gap-2" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
        <span>When</span>
        <Select aria-label={`${label}: how the conditions combine`} className="w-28" value={mode} disabled={disabled}
          onChange={(e) => onChange(e.target.value === "all" ? { all: parts } : { any: parts })}>
          <option value="all">all of</option>
          <option value="any">any of</option>
        </Select>
        <span>these hold</span>
      </div>
      {parts.map((p, i) => isClause(p)
        ? <ClauseRow key={i} n={i + 1} c={p} catalog={catalog} disabled={disabled} onChange={(c) => set(parts.map((x, j) => (j === i ? c : x)))} onRemove={() => set(parts.filter((_, j) => j !== i))} />
        : <span key={i} className="text-body-sm text-fg-3">A nested group of conditions (kept as it is)</span>)}
      {!disabled && parts.length < CLAUSES_MAX && (
        <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => set([...parts, { field: "", op: "eq", value: "" }])}>Add a condition</Button>
      )}
    </fieldset>
  );
}
