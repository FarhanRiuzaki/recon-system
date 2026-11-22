"use client";

import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useId } from "react";
import { Combobox, type ComboOption } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, CopyIcon, MenuIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import {
  ATTR_LABEL, ATTRS, type Attr, type Condition, CONDITIONS_MAX, type Group, GROUPS_MAX, type Level, LEVELS_MAX, type Need, NUMBER_OPS, NUMERIC_ATTRS, OP_LABEL, PEOPLE_MAX, type Rule,
  RULES_MAX, SET_OPS,
} from "@starterkit/shared/workflows";

/** A rule with a key that survives reordering (dnd-kit's id). */
export type KeyedRule = { key: string; rule: Rule };
export type Options = { people: { id: string; name: string }[]; globalRoles: string[]; recons: { id: string; name: string }[] };

const newGroup = (): Group => ({ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } });
export const newLevel = (): Level => ({ name: "", groups: [newGroup()] });
export const newRule = (i: number): Rule => ({ name: `Rule ${i + 1}`, when: [], levels: [newLevel()] });

/** The minor-unit exponent of a rule's amounts: its one currency (a currency "is one of" with one value), else 2. */
const exponentOf = (r: Rule) => {
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

const enc = { role: (r: string) => `role:${r}`, global: (r: string) => `global:${r}`, user: (u: string) => `user:${u}` };
/** Who may approve a group: space roles, global roles and people, in one searchable multi-pick. */
function ApproverPicker({ g, onChange, options, disabled, label }: { g: Group; onChange: (g: Group) => void; options: Options; disabled: boolean; label: string }) {
  const opts: ComboOption[] = [
    ...SPACE_ROLES.map((r) => ({ value: enc.role(r), label: ROLE_LABEL[r], group: "Roles in this space" })),
    ...options.globalRoles.map((r) => ({ value: enc.global(r), label: r, group: "App roles" })),
    ...options.people.map((p) => ({ value: enc.user(p.id), label: p.name, group: "People" })),
  ];
  const value = [...g.spaceRoles.map(enc.role), ...g.globalRoles.map(enc.global), ...g.users.map(enc.user)];
  return (
    <Combobox label={label} multiple options={opts} value={value} disabled={disabled} placeholder="Pick roles or people" searchPlaceholder="Search roles and people"
      onValueChange={(v) => onChange({
        ...g,
        spaceRoles: v.filter((x) => x.startsWith("role:")).map((x) => x.slice(5)) as Group["spaceRoles"],
        globalRoles: v.filter((x) => x.startsWith("global:")).map((x) => x.slice(7)),
        users: v.filter((x) => x.startsWith("user:")).map((x) => x.slice(5)).slice(0, PEOPLE_MAX),
      })} />
  );
}

const NEED_KIND = [{ value: "any", label: "Any one of" }, { value: "all", label: "Everyone in" }, { value: "count", label: "A number of" }] as const;
/** How many of a group must approve: any one, everyone, or a number (2…). */
function NeedPicker({ need, onChange, disabled, label }: { need: Need; onChange: (n: Need) => void; disabled: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Select aria-label={label} className="w-36" value={need.kind} disabled={disabled}
        onChange={(e) => onChange(e.target.value === "count" ? { kind: "count", n: 2 } : { kind: e.target.value as "any" | "all" })}>
        {NEED_KIND.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </Select>
      {need.kind === "count" && (
        <Input aria-label={`${label}: how many`} type="number" min={2} max={PEOPLE_MAX} className="w-20" disabled={disabled} value={need.n}
          onChange={(e) => { const n = Math.max(2, Math.min(PEOPLE_MAX, Number(e.target.value) || 2)); onChange({ kind: "count", n }); }} />
      )}
    </div>
  );
}

/** A rule's levels as a vertical stepper: each level a name and its groups (AND), approvals in order top to bottom. */
function Levels({ rule, onChange, options, disabled, ruleN }: { rule: Rule; onChange: (r: Rule) => void; options: Options; disabled: boolean; ruleN: number }) {
  const setLevel = (i: number, l: Level) => onChange({ ...rule, levels: rule.levels.map((x, j) => (j === i ? l : x)) });
  const move = (i: number, d: -1 | 1) => onChange({ ...rule, levels: arrayMove(rule.levels, i, i + d) });
  return (
    <ol className="grid" aria-label={`Rule ${ruleN}: levels in order`}>
      {rule.levels.map((l, i) => (
        <li key={i} className="relative grid grid-cols-[28px_1fr] gap-x-3 pb-4 last:pb-0">
          {i < rule.levels.length - 1 && <span aria-hidden="true" className="absolute top-7 bottom-0 left-3.25 w-px bg-line-strong" />}
          <span aria-hidden="true" className="relative z-1 grid size-7 place-items-center rounded-full bg-primary-soft text-label text-primary tabular">{i + 1}</span>
          <div className="grid min-w-0 gap-2 rounded-lg border border-line bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-label text-fg-2">Level {i + 1}</span>
              <Input aria-label={`Rule ${ruleN}, level ${i + 1}: name (optional)`} placeholder="Name (optional), e.g. Treasury head" value={l.name} disabled={disabled} maxLength={80}
                className="h-8 min-w-0 flex-1" onChange={(e) => setLevel(i, { ...l, name: e.target.value })} />
              {!disabled && (
                <span className="flex shrink-0">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move level ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon icon={ArrowUpIcon} /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move level ${i + 1} down`} disabled={i === rule.levels.length - 1} onClick={() => move(i, 1)}><Icon icon={ArrowDownIcon} /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove level ${i + 1}`} disabled={rule.levels.length === 1}
                    onClick={() => onChange({ ...rule, levels: rule.levels.filter((_, j) => j !== i) })}><Icon icon={RemoveIcon} /></Button>
                </span>
              )}
            </div>
            {l.groups.map((g, gi) => (
              <div key={gi} className="grid gap-2">
                {gi > 0 && <span className="flex items-center gap-2 text-caption text-fg-3"><span className="h-px flex-1 bg-line" />and<span className="h-px flex-1 bg-line" /></span>}
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 max-md:grid-cols-1">
                  <NeedPicker need={g.need} disabled={disabled} label={`Rule ${ruleN}, level ${i + 1}, group ${gi + 1}: how many approve`}
                    onChange={(need) => setLevel(i, { ...l, groups: l.groups.map((x, j) => (j === gi ? { ...x, need } : x)) })} />
                  <ApproverPicker g={g} disabled={disabled} options={options} label={`Rule ${ruleN}, level ${i + 1}, group ${gi + 1}: approvers`}
                    onChange={(ng) => setLevel(i, { ...l, groups: l.groups.map((x, j) => (j === gi ? ng : x)) })} />
                  {!disabled && l.groups.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove group ${gi + 1} of level ${i + 1}`}
                      onClick={() => setLevel(i, { ...l, groups: l.groups.filter((_, j) => j !== gi) })}><Icon icon={CloseIcon} /></Button>
                  )}
                </div>
              </div>
            ))}
            {!disabled && l.groups.length < GROUPS_MAX && (
              <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => setLevel(i, { ...l, groups: [...l.groups, newGroup()] })}>
                Add a group that must also approve
              </Button>
            )}
          </div>
        </li>
      ))}
      {!disabled && rule.levels.length < LEVELS_MAX && (
        <li className="grid grid-cols-[28px_1fr] gap-x-3 pt-3">
          <span />
          <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => onChange({ ...rule, levels: [...rule.levels, newLevel()] })}>
            Add level {rule.levels.length + 1}
          </Button>
        </li>
      )}
    </ol>
  );
}

function RuleCard({ k, rule, n, total, onChange, onRemove, onCopy, options, disabled }: {
  k: string; rule: Rule; n: number; total: number; onChange: (r: Rule) => void; onRemove: () => void; onCopy: () => void; options: Options; disabled: boolean;
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
      <section className="grid gap-2" aria-label={`Rule ${n}: who approves`}>
        <h3 className="text-label text-fg-2">Approved by</h3>
        <Levels rule={rule} onChange={onChange} options={options} disabled={disabled} ruleN={n} />
      </section>
    </li>
  );
}

/** The rules in order (drag or keyboard to reorder); the first whose conditions all hold decides the chain. */
export function RulesEditor({ rules, onChange, options, disabled }: { rules: KeyedRule[]; onChange: (r: KeyedRule[]) => void; options: Options; disabled: boolean }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = rules.findIndex((r) => r.key === e.active.id), to = rules.findIndex((r) => r.key === e.over!.id);
    onChange(arrayMove(rules, from, to));
  };
  const set = (k: string, rule: Rule) => onChange(rules.map((r) => (r.key === k ? { key: k, rule } : r)));
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
      <div className="grid gap-1 rounded-xl border border-dashed border-line-strong p-4">
        <span className="text-label text-fg-2">{rules.length ? "Anything no rule matches" : "Every request"}</span>
        <span className="text-body-sm text-fg-3">Default chain · 1 of Reviewer or Space admin</span>
      </div>
      {!disabled && rules.length < RULES_MAX && (
        <Button type="button" variant="secondary" className="justify-self-start" onClick={() => onChange([...rules, { key: crypto.randomUUID(), rule: newRule(rules.length) }])}>
          Add rule
        </Button>
      )}
      {rules.length > 0 && <span className="sr-only">{formatNumber(rules.length)} rules</span>}
    </div>
  );
}
