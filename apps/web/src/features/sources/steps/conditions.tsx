"use client";

import { Button } from "@starterkit/ui/ui/button";
import { Combobox, type ComboOption, InfoTip, Panel } from "@starterkit/ui/ds";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { FieldSpec, SourceCondition, SourceSpec } from "@starterkit/shared/contracts/sources";
import { ctl } from "./model";

type Op = SourceCondition["op"];
type Kind = "text" | "number" | "day";
const kindOf = (t: FieldSpec["type"] | undefined): Kind => (t === "integer" || t === "decimal" ? "number" : t === "date" || t === "datetime" ? "day" : "text");

/** What each comparison reads as, by the column's kind (a date is after or before, a number greater or less). */
const OP_LABEL: Record<Op, string | Record<Kind, string>> = {
  eq: "is", ne: "is not", in: "is one of", not_in: "is none of", is_null: "is empty", not_null: "is not empty",
  gt: { number: "is greater than", day: "is after", text: "" }, gte: { number: "is at least", day: "is on or after", text: "" },
  lt: { number: "is less than", day: "is before", text: "" }, lte: { number: "is at most", day: "is on or before", text: "" },
};
const opLabel = (op: Op, kind: Kind) => { const l = OP_LABEL[op]; return typeof l === "string" ? l : l[kind]; };
const OPS: Record<Kind, Op[]> = {
  text: ["eq", "ne", "in", "not_in", "is_null", "not_null"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "is_null", "not_null"],
  day: ["eq", "gt", "gte", "lt", "lte", "is_null", "not_null"],
};

/** A condition as a sentence: "status is one of Successful, Accepted", "value_date is on or after today-1". */
export function conditionText(c: SourceCondition, s: SourceSpec): string {
  const kind = kindOf(s.fields.find((f) => f.name === c.field)?.type);
  const value = "values" in c ? c.values.join(", ") : "value" in c ? c.value : "";
  return `${c.field} ${opLabel(c.op, kind)}${value ? ` ${value}` : ""}`;
}

/** The condition a new op starts as, keeping what was typed where it still fits. */
function withOp(c: SourceCondition, op: Op): SourceCondition {
  const typed = "value" in c ? [c.value] : "values" in c ? c.values : [];
  if (op === "is_null" || op === "not_null") return { field: c.field, op };
  if (op === "in" || op === "not_in") return { field: c.field, op, values: typed.filter(Boolean) };
  return { field: c.field, op, value: typed[0] ?? "" } as SourceCondition;
}

/**
 * Rows to load (owner, 21 Nov: the source hands the recon a clean data mart): conditions every row must meet, such as
 * status is Successful or the value date is today or later. Other rows are left out: not stored, not quarantined, only
 * counted. Not for rows that can change (a row that stops meeting them would stay as it was).
 */
export function RowsToLoad({ spec, setSpec, err, examples }: {
  spec: SourceSpec; setSpec: (fn: (s: SourceSpec) => SourceSpec) => void; err: (id: string) => string | undefined; examples: Map<string, string[]>;
}) {
  const keep = spec.keep ?? [];
  const columns: ComboOption[] = [...spec.fields.map((f) => f.name), ...Object.keys(spec.derive)].map((n) => ({ value: n, label: n }));
  const typeOf = (n: string) => spec.fields.find((f) => f.name === n)?.type;
  const setAt = (i: number, c: SourceCondition | null) =>
    setSpec((x) => ({ ...x, keep: (x.keep ?? []).flatMap((y, j) => (j !== i ? [y] : c ? [c] : [])) }));
  const add = () => {
    const first = spec.fields.find((f) => kindOf(f.type) === "text") ?? spec.fields[0];
    if (first) setSpec((x) => ({ ...x, keep: [...(x.keep ?? []), { field: first.name, op: "eq", value: "" }] }));
  };
  return (
    <Panel title="Rows to load" description={keep.length ? "Only rows that meet every condition are loaded" : "Every row is loaded"}
      actions={!spec.mutable && spec.fields.length > 0 && <Button type="button" variant="create" size="sm" onClick={add}><Icon icon={AddIcon} />Add a condition</Button>}
      bodyClassName="grid gap-3">
      <p className="flex items-center gap-1 text-body-sm text-fg-2">
        {spec.mutable
          ? "Rows that can change are all loaded: a row that stops meeting a condition would stay as it was. Filter in the recon instead."
          : keep.length ? "Other rows are left out: not stored and not quarantined, only counted." : "Add a condition to load only the rows the recons need, such as successful transactions."}
        <InfoTip label="Rows to load">
          Conditions keep the source clean before any recon reads it. Text is compared without case, so Successful and SUCCESSFUL are the same.
          A date can be today, today-1 or today+7: the day the rows arrive, or the date a snapshot is taken for.
        </InfoTip>
      </p>
      {keep.length > 0 && (
        <ol className="grid gap-2">
          {keep.map((c, i) => {
            const id = ctl(`keep.${i}`);
            const kind = kindOf(typeOf(c.field));
            const why = err(id) ?? err(`${id}-field`) ?? err(`${id}-op`) ?? err(`${id}-value`);
            const seen: ComboOption[] = [...new Set(examples.get(c.field) ?? [])].filter(Boolean).map((v) => ({ value: v, label: v }));
            return (
              <li key={i} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-tray px-3 py-2">
                  <Combobox id={`${id}-field`} label={`Condition ${i + 1}: column`} className="w-48" options={columns} value={columns.find((o) => o.value === c.field) ?? null}
                    placeholder="Pick a column" onChange={(o) => o && setAt(i, withOp({ ...c, field: o.value }, OPS[kindOf(typeOf(o.value))].includes(c.op) ? c.op : "eq"))} />
                  <Select id={`${id}-op`} aria-label={`Condition ${i + 1}: comparison`} className="w-44" value={c.op} onChange={(e) => setAt(i, withOp(c, e.target.value as Op))}>
                    {OPS[kind].map((op) => <option key={op} value={op}>{opLabel(op, kind)}</option>)}
                  </Select>
                  {"values" in c ? (
                    <Combobox multiple id={`${id}-value`} label={`Condition ${i + 1}: values`} className="min-w-56 flex-1" options={seen}
                      value={c.values.map((v) => ({ value: v, label: v }))} placeholder="Type a value and press Enter"
                      onCreate={(text) => ({ value: text.trim(), label: text.trim() })} onChange={(v) => setAt(i, { ...c, values: v.map((o) => o.value) })} />
                  ) : "value" in c ? (
                    <Input id={`${id}-value`} aria-label={`Condition ${i + 1}: value`} className="min-w-40 flex-1 font-mono" value={c.value}
                      placeholder={kind === "day" ? "yyyy-MM-dd or today-1" : kind === "number" ? "1500.00" : seen[0]?.value ?? "Successful"}
                      onChange={(e) => setAt(i, { ...c, value: e.target.value })} autoComplete="off" spellCheck={false} />
                  ) : null}
                  <Button type="button" variant="remove" size="icon-sm" className="ml-auto" aria-label={`Remove condition ${i + 1}`} onClick={() => setAt(i, null)}><Icon icon={RemoveIcon} /></Button>
                </div>
                {why && <p role="alert" className="text-caption text-down-ink">{why}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
