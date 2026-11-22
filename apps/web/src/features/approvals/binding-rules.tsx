"use client";

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useId } from "react";
import { Combobox, type ComboOption } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon, CopyIcon, MenuIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import {
  ATTR_LABEL, ATTRS, type Attr, type BindingRule, type Condition, CONDITIONS_MAX, NUMBER_OPS, NUMERIC_ATTRS, OP_LABEL, RULES_MAX, SET_OPS,
} from "@starterkit/shared/workflows";

// A space's approval rules for one trigger (DEC-052 revision §4.3): ordered rules, each conditions and the library
// workflow it picks, then the workflow anything else takes.

/** A rule with a key that survives reordering (dnd-kit's id). */
export type KeyedRule = { key: string; rule: BindingRule };
/** The library workflows a rule may pick (live, not archived) and the space's recons a condition may name. */
export type Options = { library: { id: string; name: string; levels: number }[]; recons: { id: string; name: string }[] };
const newRule = (i: number, workflowId: string): BindingRule => ({ name: `Rule ${i + 1}`, when: [], workflowId });
const levelsText = (n: number) => `${n} ${n === 1 ? "level" : "levels"}`;

/** One library workflow out of `options.library` (single pick); "" = none picked yet. */
function WorkflowPicker({ value, onChange, options, disabled, label, extra }: {
  value: string; onChange: (id: string) => void; options: Options; disabled: boolean; label: string; extra?: ComboOption;
}) {
  const opts: ComboOption[] = [...(extra ? [extra] : []), ...options.library.map((w) => ({ value: w.id, label: w.name, description: levelsText(w.levels) }))];
  return (
    <Combobox label={label} options={opts} value={value ? [value] : []} disabled={disabled} placeholder="Pick a workflow" searchPlaceholder="Search workflows"
      onValueChange={(v) => { const id = v.at(-1); if (id) onChange(id); }} />
  );
}

/** The minor-unit exponent of a rule's amounts: its one currency (a currency "is one of" with one value), else 2. */
const exponentOf = (r: BindingRule) => {
  const c = r.when.find((x) => x.attr === "currency" && x.op === "in" && Array.isArray(x.value) && x.value.length === 1);
  return c ? (CURRENCY_EXPONENT[(c.value as string[])[0]!] ?? 2) : 2;
};
const toMajor = (minor: string, e: number) => (minor === "" ? "" : e === 0 ? minor : `${minor.slice(0, -e) || "0"}${minor.slice(-e).replace(/0+$/, "") ? `.${minor.slice(-e).padStart(e, "0").replace(/0+$/, "")}` : ""}`);
const toMinor = (major: string, e: number): string | null => {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(major.replace(/[\s,]/g, ""));
  if (!m || (m[2] && m[2].length > e)) return null;
  return String(BigInt(m[1]! + (m[2] ?? "").padEnd(e, "0")));
};

const SELECT = "w-full";

/** One condition: attribute, comparison, value(s); a number for amount and age, a pick list for currency and recon. */
function ConditionRow({ c, e, onChange, onRemove, options, disabled, n }: { c: Condition; e: number; onChange: (c: Condition) => void; onRemove: () => void; options: Options; disabled: boolean; n: number }) {
  const numeric = NUMERIC_ATTRS.includes(c.attr);
  const pick: ComboOption[] = c.attr === "currency"
    ? Object.keys(CURRENCY_EXPONENT).map((k) => ({ value: k, label: k }))
    : options.recons.map((r) => ({ value: r.id, label: r.name }));
  const raw = Array.isArray(c.value) ? c.value[0] ?? "" : c.value;
  return (
    <div className="grid grid-cols-[1fr_1fr_1.4fr_auto] items-center gap-2 max-md:grid-cols-2">
      <Select aria-label={`Condition ${n}: what it tests`} className={SELECT} value={c.attr} disabled={disabled}
        onChange={(ev) => { const attr = ev.target.value as Attr; const num = NUMERIC_ATTRS.includes(attr); onChange({ attr, op: num ? "gte" : "in", value: num ? "0" : [] as never }); }}>
        {ATTRS.map((a) => <option key={a} value={a}>{ATTR_LABEL[a]}</option>)}
      </Select>
      <Select aria-label={`Condition ${n}: comparison`} className={SELECT} value={c.op} disabled={disabled} onChange={(ev) => onChange({ ...c, op: ev.target.value as Condition["op"] })}>
        {(numeric ? NUMBER_OPS : SET_OPS).map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
      </Select>
      {numeric ? (
        <Input aria-label={`Condition ${n}: ${c.attr === "amount" ? "amount" : "days"}`} inputMode="decimal" disabled={disabled}
          defaultValue={c.attr === "amount" ? toMajor(raw, e) : raw} key={`${c.attr}:${raw}:${e}`}
          onBlur={(ev) => { const v = c.attr === "amount" ? toMinor(ev.target.value, e) : /^\d{1,6}$/.test(ev.target.value) ? ev.target.value : null; if (v !== null) onChange({ ...c, value: v }); else ev.target.value = c.attr === "amount" ? toMajor(raw, e) : raw; }} />
      ) : (
        <Combobox label={`Condition ${n}: ${c.attr === "currency" ? "currencies" : "recons"}`} multiple options={pick} disabled={disabled}
          value={Array.isArray(c.value) ? c.value : []} onValueChange={(v) => onChange({ ...c, value: v })} placeholder={c.attr === "currency" ? "Pick currencies" : "Pick recons"} />
      )}
      {!disabled && <Button type="button" variant="ghost" size="icon" aria-label={`Remove condition ${n}`} onClick={onRemove}><Icon icon={CloseIcon} /></Button>}
    </div>
  );
}

function RuleCard({ k, rule, n, total, onChange, onRemove, onCopy, options, disabled }: {
  k: string; rule: BindingRule; n: number; total: number; onChange: (r: BindingRule) => void; onRemove: () => void; onCopy: () => void; options: Options; disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform: t, transition, isDragging } = useSortable({ id: k, disabled });
  const e = exponentOf(rule);
  const setCond = (i: number, c: Condition) => onChange({ ...rule, when: rule.when.map((x, j) => (j === i ? c : x)) });
  return (
    <li ref={setNodeRef} style={t ? { transform: `translate3d(${Math.round(t.x)}px, ${Math.round(t.y)}px, 0)`, transition } : undefined}
      className={cn("grid gap-4 rounded-xl border border-line bg-sheet p-4 shadow-xs", isDragging && "relative z-10 shadow-overlay")}>
      <div className="flex items-center gap-2">
        {!disabled && total > 1 && (
          <button type="button" {...attributes} {...listeners} aria-label={`Move rule ${n}`} className="grid size-8 cursor-grab place-items-center rounded-md text-fg-3 hover:bg-tray active:cursor-grabbing">
            <Icon icon={MenuIcon} />
          </button>
        )}
        <span className="shrink-0 rounded-full bg-tray px-2 py-0.5 text-caption text-fg-2 tabular">{n}</span>
        <Input aria-label={`Rule ${n}: name`} value={rule.name} disabled={disabled} maxLength={80} className="h-9 min-w-0 flex-1 text-body font-medium" onChange={(ev) => onChange({ ...rule, name: ev.target.value })} />
        {!disabled && (
          <span className="flex shrink-0">
            <Button type="button" variant="ghost" size="icon" aria-label={`Copy rule ${n}`} disabled={total >= RULES_MAX} onClick={onCopy}><Icon icon={CopyIcon} /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove rule ${n}`} onClick={onRemove}><Icon icon={RemoveIcon} /></Button>
          </span>
        )}
      </div>
      <section className="grid gap-2" aria-label={`Rule ${n}: when it applies`}>
        <h3 className="text-label text-fg-2">When</h3>
        {rule.when.length === 0 && <p className="text-body-sm text-fg-3">Every request this rule reaches</p>}
        {rule.when.map((c, i) => (
          <ConditionRow key={i} n={i + 1} c={c} e={e} options={options} disabled={disabled} onChange={(nc) => setCond(i, nc)}
            onRemove={() => onChange({ ...rule, when: rule.when.filter((_, j) => j !== i) })} />
        ))}
        {!disabled && rule.when.length < CONDITIONS_MAX && (
          <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => onChange({ ...rule, when: [...rule.when, { attr: "amount", op: "gte", value: "0" }] })}>
            Add condition
          </Button>
        )}
      </section>
      <section className="grid gap-2 md:max-w-md" aria-label={`Rule ${n}: workflow`}>
        <h3 className="text-label text-fg-2">Use workflow <span aria-hidden="true" className="text-down-ink">*</span></h3>
        <WorkflowPicker label={`Rule ${n}: workflow`} value={rule.workflowId} options={options} disabled={disabled} onChange={(workflowId) => onChange({ ...rule, workflowId })} />
      </section>
    </li>
  );
}

const DEFAULT_OPTION: ComboOption = { value: "default", label: "Default chain", description: "1 of Reviewer or Space admin" };
/**
 * The rules in order (drag or keyboard to reorder); the first whose conditions all hold picks the workflow, else
 * `otherwise` (null = the default chain).
 */
export function RulesEditor({ rules, onChange, otherwise, onOtherwise, options, disabled }: {
  rules: KeyedRule[]; onChange: (r: KeyedRule[]) => void; otherwise: string | null; onOtherwise: (id: string | null) => void; options: Options; disabled: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = rules.findIndex((r) => r.key === e.active.id), to = rules.findIndex((r) => r.key === e.over!.id);
    onChange(arrayMove(rules, from, to));
  };
  const set = (k: string, rule: BindingRule) => onChange(rules.map((r) => (r.key === k ? { key: k, rule } : r)));
  return (
    <div className="grid gap-3">
      <DndContext id={useId()} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}
        accessibility={{ announcements: { onDragStart: () => "Picked up a rule.", onDragOver: ({ over }) => (over ? `Over rule ${rules.findIndex((r) => r.key === over.id) + 1}.` : ""), onDragEnd: ({ over }) => (over ? `Moved to rule ${rules.findIndex((r) => r.key === over.id) + 1}.` : "Not moved."), onDragCancel: () => "Not moved." } }}>
        <SortableContext items={rules.map((r) => r.key)} strategy={verticalListSortingStrategy}>
          <ol className="grid gap-3">
            {rules.map((r, i) => (
              <RuleCard key={r.key} k={r.key} rule={r.rule} n={i + 1} total={rules.length} options={options} disabled={disabled} onChange={(nr) => set(r.key, nr)}
                onRemove={() => onChange(rules.filter((x) => x.key !== r.key))}
                onCopy={() => onChange([...rules.slice(0, i + 1), { key: crypto.randomUUID(), rule: { ...structuredClone(r.rule), name: `${r.rule.name} (copy)`.slice(0, 80) } }, ...rules.slice(i + 1)])} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="grid gap-2 rounded-xl border border-dashed border-line-strong p-4">
        <span className="text-label text-fg-2">{rules.length ? "Anything no rule matches" : "Every request"}</span>
        <span className="md:max-w-md">
          <WorkflowPicker label={rules.length ? "Workflow for anything no rule matches" : "Workflow for every request"} value={otherwise ?? "default"} options={options} disabled={disabled}
            extra={DEFAULT_OPTION} onChange={(id) => onOtherwise(id === "default" ? null : id)} />
        </span>
      </div>
      {!disabled && rules.length < RULES_MAX && (
        <Button type="button" variant="secondary" className="justify-self-start" disabled={!options.library.length}
          onClick={() => onChange([...rules, { key: crypto.randomUUID(), rule: newRule(rules.length, options.library[0]!.id) }])}>
          Add rule
        </Button>
      )}
      {rules.length > 0 && <span className="sr-only">{formatNumber(rules.length)} rules</span>}
    </div>
  );
}
