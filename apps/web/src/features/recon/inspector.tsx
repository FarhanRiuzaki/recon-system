"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { ActionMenu, BlockedButton, Field, InputAffix, NumberInput, Segmented } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon, FailedIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import type { PassSpec, Predicate, ReconSpec, SideSpec } from "@starterkit/shared/contracts/recon";
import { CARDINALITIES, type FieldPair, type Operator, sideRef } from "@starterkit/shared/recon";
import {
  addCurrency, CURRENCIES, currencyDecimals, FILTER_OPS, type FilterOp, fieldFor, fieldName, fieldReason, fieldRefs, type Fields, isGroup, kindOf, moveReason, OPS,
  type Place, predicateOf, removeCurrency, renameCurrency, restoreCondition, restoreFilter, restoreKey, restoreTolerance, splitValues, startField, withCardinality, withFilterOp, withSide,
} from "./spec-model";

// The inspector (BUILDER-SPEC "Inspector"): the selected pass, a side or the settings. Every control writes the whole
// object back (onChange); the builder keeps the spec and saves it whole (PATCH …/versions/{id}).

// the searchable field list (cmdk) loads on first render, outside the route's first load (AGENTS §9)
const Combobox = dynamic(() => import("@starterkit/ui/ds/combobox-command").then((m) => m.CommandCombobox), { ssr: false, loading: () => <Skeleton className="h-8 w-full" /> });

/** An API sentence under the control it names (Down ink with an icon, never colour alone). */
export function PlaceError({ id, text }: { id?: string; text: string | null | undefined }) {
  if (!text) return null;
  return <p id={id} role="alert" className="flex items-start gap-1.5 text-body-sm text-down-ink"><Icon icon={FailedIcon} className="mt-0.5 size-3.5 shrink-0" />{text}</p>;
}

/**
 * One side's field for a matching key or condition: the side's stored names (its source field or attribute); a field
 * whose kind doesn't fit the operator, or (side B) differs from side A's, is listed off with the reason.
 */
function FieldPick({ id, label, i, pair, op, fields, onPick }: {
  id: string; label: string; i: 0 | 1; pair: FieldPair; op: Operator | "key"; fields: Fields; onPick: (pair: FieldPair) => void;
}) {
  const other = i === 1 ? kindOf(pair, 0, fields) : null;
  const options = fieldRefs(fields[i]).map((ref) => {
    const kind = fields[i]!.get(ref)!.kind;
    const why = fieldReason(op, kind, ref, other);
    return { value: ref, label: fieldName(ref, fields[i]), mono: true, description: why ?? kind, disabled: !!why };
  });
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption text-fg-3">{label}</span>
      <Combobox id={id} label={`${label} field`} value={[sideRef(pair, i)]} options={options} phone="sheet" placeholder="Choose a field" searchPlaceholder="Search fields"
        emptyText={fields[i] ? "No field matches." : "This side's source is still loading."} onValueChange={(v) => { if (v[0]) onPick(withSide(pair, i, v[0])); }} />
    </div>
  );
}

/** A tolerance per currency in major units: one row per currency; a currency without a row matches exactly. */
function ToleranceRows({ id, value, onChange, onRemoved }: { id: string; value: Record<string, string>; onChange: (t: Record<string, string>) => void; onRemoved?: (code: string, value: string) => void }) {
  const rows = Object.entries(value);
  const free = CURRENCIES.filter((c) => !Object.hasOwn(value, c));
  return (
    <div className="grid gap-2">
      {rows.map(([code, v]) => (
        <div key={code} className="flex items-center gap-2">
          <Select aria-label="Currency" value={code} onChange={(e) => onChange(renameCurrency(value, code, e.target.value))} className="w-24">
            {[code, ...free].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Input id={`${id}-${code}`} aria-label={`${code} tolerance`} inputMode="decimal" value={v} className="min-w-0 flex-1 tabular" placeholder={(0).toFixed(currencyDecimals(code))}
            onChange={(e) => onChange({ ...value, [code]: e.target.value.trim() })} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove the ${code} tolerance`} onClick={() => { onChange(removeCurrency(value, code)); onRemoved?.(code, v); }}><Icon icon={CloseIcon} /></Button>
        </div>
      ))}
      {free.length > 0 && <span><Button type="button" variant="ghost" size="sm" onClick={() => onChange(addCurrency(value))}>Add currency</Button></span>}
    </div>
  );
}

/** The operator's own value: a tolerance, a percentage, a number of days or a similarity. */
function OpValue({ id, q, onChange, onToleranceRemoved }: { id: string; q: Predicate; onChange: (q: Predicate) => void; onToleranceRemoved?: (code: string, value: string) => void }) {
  switch (q.op) {
    case "amount_abs_tol": case "eq_sum": return <ToleranceRows id={id} value={q.tolerance} onChange={(tolerance) => onChange({ ...q, tolerance })} onRemoved={onToleranceRemoved} />;
    case "amount_pct_tol": return <InputAffix id={id} aria-label="Percentage" inputMode="decimal" suffix="%" value={q.percent} onChange={(e) => onChange({ ...q, percent: e.target.value.trim() })} />;
    case "date_window": case "bday_window": return <NumberInput id={id} label={q.op === "date_window" ? "Days apart" : "Business days apart"} min={1} max={31} value={q.days} onValueChange={(d) => onChange({ ...q, days: d === "" ? 1 : d })} />;
    case "similarity": return <NumberInput id={id} label="Least similarity" min={0.1} max={1} step={0.05} value={q.min} onValueChange={(m) => onChange({ ...q, min: m === "" ? 0.8 : m })} />;
    default: return null;
  }
}

const pairLabels = (spec: ReconSpec) => [spec.sides[0].label, spec.sides[1].label] as const;

/** A row of the inspector: the two sides' fields, then what compares them. */
/**
 * One row of keys, conditions or filters, with × at its end. The draft saves itself, so a removal asks nothing: it
 * runs at once and the toast's Undo puts the row back (ui-standard §1a: an autosaving editor's exception).
 */
function PairRow({ children, error, onRemove, removeReason, removeLabel }: { children: ReactNode; error?: string | null; onRemove: () => void; removeReason: string | null; removeLabel: string }) {
  return (
    <div className="grid gap-2 border-b border-line pb-3 last:border-b-0">
      <div className="flex items-start gap-1">
        <div className="grid min-w-0 flex-1 gap-2">{children}</div>
        <BlockedButton type="button" variant="ghost" size="icon-sm" aria-label={removeLabel} reason={removeReason} onClick={onRemove}><Icon icon={CloseIcon} /></BlockedButton>
      </div>
      <PlaceError text={error} />
    </div>
  );
}

/**
 * A removal's Undo, run by the builder on the spec as it is then: `restore` puts the one removed item back into the
 * current spec (the pass's current index `i`), or null when it can't go back.
 */
export type OnRemoved<A extends unknown[]> = (message: string, restore: (spec: ReconSpec, ...at: A) => ReconSpec | null) => void;

/**
 * The selected pass (BUILDER-SPEC "Inspector"): name, cardinality, when found, the matching keys, the conditions (all
 * must pass), when several candidates fit, and its place in the run order. A group pass matches automatically or
 * raises breaks only in this release, so those two controls hold one choice there.
 */
export function PassEditor({ spec, i, fields, place, onChange, onMove, onRemove, onRemoved }: {
  spec: ReconSpec; i: number; fields: Fields; place: Place | null;
  onChange: (p: PassSpec) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void; onRemoved: OnRemoved<[number]>;
}) {
  const p = spec.passes[i]!;
  const n = spec.passes.length;
  const [la, lb] = pairLabels(spec);
  const group = isGroup(p);
  const id = (s: string) => `rp-${i}-${s}`;
  const setPred = (j: number, q: Predicate) => onChange({ ...p, predicates: p.predicates.map((x, k) => (k === j ? q : x)) });
  const sums = p.predicates.filter((q) => q.op === "eq_sum").length;
  return (
    <div className="grid gap-5">
      {place && place.condition === undefined && place.key === undefined && <PlaceError text={place.text} />}
      <Field id={id("name")} label="Name">
        <Input id={id("name")} value={p.name} maxLength={64} onChange={(e) => onChange({ ...p, name: e.target.value })} autoComplete="off" />
      </Field>
      <div className="grid gap-2">
        <span className="text-label text-fg">Cardinality ({la} : {lb})</span>
        <Segmented label="Cardinality" value={p.cardinality} options={CARDINALITIES.map((c) => ({ value: c, label: c }))} onChange={(c) => onChange(withCardinality(p, c, fields))} />
      </div>
      <div className="grid gap-2">
        <span className="text-label text-fg">When found</span>
        <Segmented label="When found" value={p.accept} onChange={(accept) => onChange({ ...p, accept })}
          options={group ? [{ value: "auto", label: "Auto-accept" }] : [{ value: "auto", label: "Auto-accept" }, { value: "suggest", label: "Suggest" }]} />
      </div>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-label text-fg">Find candidates by</legend>
        {p.blocking.map((f, j) => (
          <PairRow key={j} error={place?.key === j ? place.text : null} removeLabel={`Remove matching key ${j + 1}`}
            removeReason={group && p.blocking.length === 1 ? "A 1:N or N:1 pass groups records by a matching key." : null}
            onRemove={() => { onChange({ ...p, blocking: p.blocking.filter((_, k) => k !== j) }); onRemoved(`Removed matching key ${j + 1}.`, (cur, at) => restoreKey(cur, at, f, j)); }}>
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldPick id={id(`key-${j}-a`)} label={la} i={0} pair={f} op="key" fields={fields} onPick={(x) => onChange({ ...p, blocking: p.blocking.map((y, k) => (k === j ? x : y)) })} />
              <FieldPick id={id(`key-${j}-b`)} label={lb} i={1} pair={f} op="key" fields={fields} onPick={(x) => onChange({ ...p, blocking: p.blocking.map((y, k) => (k === j ? x : y)) })} />
            </div>
          </PairRow>
        ))}
        <span><BlockedButton type="button" variant="ghost" size="sm" reason={p.blocking.length >= 5 ? "A pass has at most 5 matching keys." : null}
          onClick={() => onChange({ ...p, blocking: [...p.blocking, startField(fields)] })}>Add matching key</BlockedButton></span>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-label text-fg">Conditions (all must pass)</legend>
        {p.predicates.map((q, j) => (
          <PairRow key={j} error={place?.condition === j ? place.text : null} removeLabel={`Remove condition ${j + 1}`}
            removeReason={p.predicates.length === 1 ? "A pass needs at least one condition." : group && q.op === "eq_sum" && sums === 1 ? "A 1:N or N:1 pass needs one group sum condition." : null}
            onRemove={() => { onChange({ ...p, predicates: p.predicates.filter((_, k) => k !== j) }); onRemoved(`Removed condition ${j + 1}.`, (cur, at) => restoreCondition(cur, at, q, j)); }}>
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldPick id={id(`cond-${j}-a`)} label={la} i={0} pair={q.field} op={q.op} fields={fields} onPick={(field) => setPred(j, { ...q, field })} />
              <FieldPick id={id(`cond-${j}-b`)} label={lb} i={1} pair={q.field} op={q.op} fields={fields} onPick={(field) => setPred(j, { ...q, field })} />
            </div>
            <Select id={id(`cond-${j}-op`)} aria-label={`Condition ${j + 1} operator`} value={q.op} className="w-full"
              onChange={(e) => { const op = e.target.value as Operator; setPred(j, predicateOf(op, fieldFor(op, q.field, fields))); }}>
              {OPS.filter((o) => !o.group || group).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
            </Select>
            <OpValue id={id(`cond-${j}-value`)} q={q} onChange={(x) => setPred(j, x)}
              onToleranceRemoved={(code, v) => onRemoved(`Removed the ${code} tolerance.`, (cur, at) => restoreTolerance(cur, at, j, code, v))} />
          </PairRow>
        ))}
        <span><BlockedButton type="button" variant="ghost" size="sm" reason={p.predicates.length >= 20 ? "A pass has at most 20 conditions." : null}
          onClick={() => onChange({ ...p, predicates: [...p.predicates, predicateOf("eq", startField(fields))] })}>Add condition</BlockedButton></span>
      </fieldset>

      <Field id={id("ambiguous")} label="When several candidates fit">
        <Select id={id("ambiguous")} value={p.on_ambiguous} disabled={group} className="w-full" onChange={(e) => onChange({ ...p, on_ambiguous: e.target.value as PassSpec["on_ambiguous"] })}>
          {!group && <option value="suggest">Suggest them for review</option>}
          <option value="break">Raise a break</option>
        </Select>
      </Field>

      <div className="flex flex-wrap gap-2">
        <BlockedButton type="button" variant="secondary" reason={moveReason(i, n, -1)} onClick={() => onMove(-1)}>Move earlier</BlockedButton>
        <BlockedButton type="button" variant="secondary" reason={moveReason(i, n, 1)} onClick={() => onMove(1)}>Move later</BlockedButton>
        <span className="ml-auto"><ActionMenu label={`Actions for pass ${i + 1}`} actions={[{ id: "remove", label: "Remove pass", destructive: true, onSelect: onRemove }]} /></span>
      </div>
    </div>
  );
}

/** A side (BUILDER-SPEC "Side cards"): its label, the amount's sign and the filters that pick its records. */
export function SideEditor({ spec, i, fields, sourceName, place, onChange, onRemoved }: {
  spec: ReconSpec; i: 0 | 1; fields: Fields; sourceName: string; place: Place | null; onChange: (s: SideSpec) => void; onRemoved: OnRemoved<[]>;
}) {
  const s = spec.sides[i];
  const own = fields[i];
  const id = (x: string) => `rs-${i}-${x}`;
  const refs = fieldRefs(own);
  const setFilter = (j: number, f: SideSpec["filter"][number]) => onChange({ ...s, filter: s.filter.map((x, k) => (k === j ? f : x)) });
  return (
    <div className="grid gap-5">
      {place && place.filter === undefined && <PlaceError text={place.text} />}
      <Field id={id("label")} label="Label">
        <Input id={id("label")} value={s.label} maxLength={64} onChange={(e) => onChange({ ...s, label: e.target.value })} autoComplete="off" />
      </Field>
      <Field id={id("source")} label="Source">
        <Input id={id("source")} value={sourceName} readOnly />
      </Field>
      <div className="grid gap-2">
        <span className="text-label text-fg">Amount sign</span>
        <Segmented label="Amount sign" value={s.amount_sign} onChange={(amount_sign) => onChange({ ...s, amount_sign })}
          options={[{ value: "as_is", label: "As booked" }, { value: "negate", label: "Opposite sign" }]} />
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-2 text-label text-fg">Filters (records this side reads)</legend>
        {s.filter.map((f, j) => (
          <PairRow key={j} error={place?.filter === j ? place.text : null} removeLabel={`Remove filter ${j + 1}`} removeReason={null}
            onRemove={() => { onChange({ ...s, filter: s.filter.filter((_, k) => k !== j) }); onRemoved(`Removed filter ${j + 1}.`, (cur) => restoreFilter(cur, i, f, j)); }}>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select aria-label={`Filter ${j + 1} field`} value={f.field} className="w-full font-mono" onChange={(e) => setFilter(j, { ...f, field: e.target.value })}>
                {(refs.includes(f.field) ? refs : [f.field, ...refs]).map((r) => <option key={r} value={r}>{fieldName(r, own)}</option>)}
              </Select>
              <Select aria-label={`Filter ${j + 1} operator`} value={f.op} className="w-full" onChange={(e) => setFilter(j, withFilterOp(f, e.target.value as FilterOp))}>
                {FILTER_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </Select>
            </div>
            {"value" in f && <Input aria-label={`Filter ${j + 1} value`} value={f.value} maxLength={200} onChange={(e) => setFilter(j, { ...f, value: e.target.value })} />}
            {/* typed freely; the list is read on leaving the field, so a trailing comma can be typed */}
            {"values" in f && <Input key={f.values.join(",")} aria-label={`Filter ${j + 1} values, separated by commas`} defaultValue={f.values.join(", ")}
              onBlur={(e) => setFilter(j, { ...f, values: splitValues(e.target.value) })} />}
          </PairRow>
        ))}
        <span><BlockedButton type="button" variant="ghost" size="sm" reason={!refs.length ? "This side's source is still loading." : s.filter.length >= 20 ? "A side has at most 20 filters." : null}
          onClick={() => onChange({ ...s, filter: [...s.filter, { field: refs[0]!, op: "eq", value: "" }] })}>Add filter</BlockedButton></span>
      </fieldset>
    </div>
  );
}

/** The day's settings (BUILDER-SPEC "Settings strip"): schedule, grace, carry over, close time. */
export function SettingsEditor({ spec, place, onChange }: { spec: ReconSpec; place: Place | null; onChange: (s: ReconSpec) => void }) {
  const s = spec.schedule;
  const err = (name: string) => (place?.setting === name ? place.text : null);
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <span className="text-label text-fg">Schedule</span>
        <Segmented label="Schedule" value={s.kind} options={[{ value: "daily", label: "Daily" }, { value: "interval", label: "Every few minutes" }]}
          onChange={(kind) => onChange({ ...spec, schedule: kind === "daily" ? { kind, at: "06:00", business_date_offset: 1 } : { kind, every_minutes: 15 } })} />
        <PlaceError text={err("Schedule")} />
      </div>
      {s.kind === "daily" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rs-at" label={`Runs at (${APP_TIME_ZONE_LABEL})`}>
            <Input id="rs-at" type="time" value={s.at} onChange={(e) => onChange({ ...spec, schedule: { ...s, at: e.target.value } })} />
          </Field>
          <Field id="rs-offset" label="Business date">
            <Select id="rs-offset" value={s.business_date_offset} className="w-full" onChange={(e) => onChange({ ...spec, schedule: { ...s, business_date_offset: Number(e.target.value) } })}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{d === 0 ? "The same day" : d === 1 ? "The day before" : `${d} days before`}</option>)}
            </Select>
          </Field>
        </div>
      ) : (
        <Field id="rs-every" label="Every (minutes)">
          <NumberInput id="rs-every" label="Minutes between runs" min={1} max={1440} value={s.every_minutes} onValueChange={(m) => onChange({ ...spec, schedule: { ...s, every_minutes: m === "" ? 1 : m } })} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="rs-grace" label="Grace (minutes)" error={err("Grace")}>
          <NumberInput id="rs-grace" label="Grace in minutes" min={0} max={1440} value={spec.grace_minutes} onValueChange={(m) => onChange({ ...spec, grace_minutes: m === "" ? 0 : m })} />
        </Field>
        <Field id="rs-carry" label="Carry over (days)" error={err("Carry over")}>
          <NumberInput id="rs-carry" label="Carry over in days" min={0} max={31} value={spec.carry_over_days} onValueChange={(d) => onChange({ ...spec, carry_over_days: d === "" ? 0 : d })} />
        </Field>
      </div>
      <Field id="rs-close" label={`Day closes at (${APP_TIME_ZONE_LABEL})`} error={err("Close time")}>
        <Input id="rs-close" type="time" value={spec.close_at} onChange={(e) => onChange({ ...spec, close_at: e.target.value })} />
      </Field>
    </div>
  );
}
