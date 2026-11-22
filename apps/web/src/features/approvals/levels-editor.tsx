"use client";

import { arrayMove } from "@dnd-kit/sortable";
import { Combobox, type ComboOption } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";
import { type Group, GROUPS_MAX, type Level, LEVELS_MAX, type Need, PEOPLE_MAX } from "@starterkit/shared/workflows";

// A library workflow's levels (DEC-052 revision): the stepper the workflow editor edits and the request chain mirrors.

/** Who a group may name: people, app roles (space roles are fixed). */
export type Options = { people: { id: string; name: string }[]; globalRoles: string[] };

const newGroup = (): Group => ({ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } });
export const newLevel = (): Level => ({ name: "", groups: [newGroup()] });

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

/** A workflow's levels as a vertical stepper: each level a name and its groups (AND), approvals in order top to bottom. */
export function Levels({ levels, onChange, options, disabled }: { levels: Level[]; onChange: (l: Level[]) => void; options: Options; disabled: boolean }) {
  const setLevel = (i: number, l: Level) => onChange(levels.map((x, j) => (j === i ? l : x)));
  const move = (i: number, d: -1 | 1) => onChange(arrayMove(levels, i, i + d));
  return (
    <ol className="grid" aria-label="Levels in order">
      {levels.map((l, i) => (
        <li key={i} className="relative grid grid-cols-[28px_1fr] gap-x-3 pb-4 last:pb-0">
          {i < levels.length - 1 && <span aria-hidden="true" className="absolute top-7 bottom-0 left-3.25 w-px bg-line-strong" />}
          <span aria-hidden="true" className="relative z-1 grid size-7 place-items-center rounded-full bg-primary-soft text-label text-primary tabular">{i + 1}</span>
          <div className="grid min-w-0 gap-2 rounded-lg border border-line bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-label text-fg-2">Level {i + 1}</span>
              <Input aria-label={`Level ${i + 1}: name (optional)`} placeholder="Name (optional), e.g. Treasury head" value={l.name} disabled={disabled} maxLength={80}
                className="h-8 min-w-0 flex-1" onChange={(e) => setLevel(i, { ...l, name: e.target.value })} />
              {!disabled && (
                <span className="flex shrink-0">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move level ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon icon={ArrowUpIcon} /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move level ${i + 1} down`} disabled={i === levels.length - 1} onClick={() => move(i, 1)}><Icon icon={ArrowDownIcon} /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove level ${i + 1}`} disabled={levels.length === 1}
                    onClick={() => onChange(levels.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
                </span>
              )}
            </div>
            {l.groups.map((g, gi) => (
              <div key={gi} className="grid gap-2">
                {gi > 0 && <span className="flex items-center gap-2 text-caption text-fg-3"><span className="h-px flex-1 bg-line" />and<span className="h-px flex-1 bg-line" /></span>}
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 max-md:grid-cols-1">
                  <NeedPicker need={g.need} disabled={disabled} label={`Level ${i + 1}, group ${gi + 1}: how many approve`}
                    onChange={(need) => setLevel(i, { ...l, groups: l.groups.map((x, j) => (j === gi ? { ...x, need } : x)) })} />
                  <ApproverPicker g={g} disabled={disabled} options={options} label={`Level ${i + 1}, group ${gi + 1}: approvers`}
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
      {!disabled && levels.length < LEVELS_MAX && (
        <li className="grid grid-cols-[28px_1fr] gap-x-3 pt-3">
          <span />
          <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => onChange([...levels, newLevel()])}>
            Add level {levels.length + 1}
          </Button>
        </li>
      )}
    </ol>
  );
}

/** The chain's depth as numbered steps on a line: as many as the workflow has levels. */
export function LevelDots({ n, muted }: { n: number; muted?: boolean }) {
  return (
    <span aria-hidden="true" className="flex items-center">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="h-px w-3 bg-line-strong" />}
          <span className={cn("grid size-5 place-items-center rounded-full text-caption tabular", muted ? "bg-tray text-fg-3" : "bg-primary-soft text-primary")}>{i + 1}</span>
        </span>
      ))}
    </span>
  );
}
