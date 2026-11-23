"use client";

import { arrayMove } from "@dnd-kit/sortable";
import { Fragment, useEffect, useId, useReducer, useRef, useState } from "react";
import { ActionMenu, CategoryChip, Combobox, type ComboOption, EditorRow } from "@starterkit/ui/ds";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { cn } from "@starterkit/ui/lib/cn";
import { plural } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, CloseIcon, EditIcon, FailedIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";
import { type Group, GROUPS_MAX, type Level, LEVELS_MAX, type Need, PEOPLE_MAX } from "@starterkit/shared/workflows";
import { needWords } from "@/components/request-chain";
import { categoryChip } from "@/lib/shared/categories";

// A workflow's levels (DEC-052 rev 2): the cards the workflow editor edits and the request chain mirrors.

/** Who a group may name: people, app roles (space roles are fixed). */
export type Options = { people: { id: string; name: string }[]; globalRoles: string[] };

const newGroup = (): Group => ({ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } });
export const newLevel = (): Level => ({ name: "", groups: [newGroup()] });

/** The indexes of a level's groups with nobody picked to approve. */
export const emptyGroups = (l: Level): number[] =>
  l.groups.flatMap((g, i) => (g.spaceRoles.length + g.globalRoles.length + g.users.length ? [] : [i]));

const enc = { role: (r: string) => `role:${r}`, global: (r: string) => `global:${r}`, user: (u: string) => `user:${u}` };
/** A group's approvers as chips: a space role in its colour (audit chip map), app roles and people neutral. */
function approvers(g: Group, options: Options): ComboOption[] {
  return [
    ...g.spaceRoles.map((r) => ({ value: enc.role(r), label: ROLE_LABEL[r], slot: categoryChip("spaceRole", r) })),
    ...g.globalRoles.map((r) => ({ value: enc.global(r), label: r, slot: "neutral" as const })),
    ...g.users.map((u) => ({ value: enc.user(u), label: options.people.find((p) => p.id === u)?.name ?? "A removed user", slot: "neutral" as const })),
  ];
}

/** Who may approve a group: space roles, app roles and people in one searchable multi-pick, the chips inside the field. */
function ApproverPicker({ g, onChange, options, label, invalid, describedBy }: { g: Group; onChange: (g: Group) => void; options: Options; label: string; invalid: boolean; describedBy?: string }) {
  const opts: ComboOption[] = [
    ...SPACE_ROLES.map((r) => ({ value: enc.role(r), label: ROLE_LABEL[r], description: "Role in this space", slot: categoryChip("spaceRole", r) })),
    ...options.globalRoles.map((r) => ({ value: enc.global(r), label: r, description: "App role", slot: "neutral" as const })),
    ...options.people.map((p) => ({ value: enc.user(p.id), label: p.name, description: "Person", slot: "neutral" as const })),
  ];
  return (
    <Combobox multiple label={label} options={opts} value={approvers(g, options)} placeholder="Pick roles or people" invalid={invalid} describedBy={describedBy}
      emptyText="No role or person by that name."
      onChange={(v) => {
        const of = (p: string) => v.filter((x) => x.value.startsWith(p)).map((x) => x.value.slice(p.length));
        onChange({ ...g, spaceRoles: of("role:") as Group["spaceRoles"], globalRoles: of("global:"), users: of("user:").slice(0, PEOPLE_MAX) });
      }} />
  );
}

// the same words as the request chain
const NEED_KIND = [{ value: "any", label: needWords({ kind: "any" }) }, { value: "all", label: needWords({ kind: "all" }) }, { value: "count", label: "A number of" }] as const;
/** How many of a group must approve: any one, all, or a number (2…), the number under the choice. */
function NeedPicker({ need, onChange, label }: { need: Need; onChange: (n: Need) => void; label: string }) {
  return (
    <div className="grid gap-2">
      <Select aria-label={label} value={need.kind}
        onChange={(e) => onChange(e.target.value === "count" ? { kind: "count", n: 2 } : { kind: e.target.value as "any" | "all" })}>
        {NEED_KIND.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </Select>
      {need.kind === "count" && (
        <Input aria-label={`${label}: how many`} type="number" min={2} max={PEOPLE_MAX} value={need.n}
          onChange={(e) => { const n = Math.max(2, Math.min(PEOPLE_MAX, Number(e.target.value) || 2)); onChange({ kind: "count", n }); }} />
      )}
    </div>
  );
}

/** "and" between two groups that must both approve: a neutral chip at the start of the line. */
const And = () => <span className="inline-flex h-5.5 items-center justify-self-start rounded-sm bg-inset px-2 text-label text-fg-2">and</span>;

/** A group read back: "Any one of" and a chip per role or person; nobody picked is the error colour with its icon. */
function GroupLine({ g, options }: { g: Group; options: Options }) {
  const chips = approvers(g, options);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-body-sm text-fg-2">
      {needWords(g.need)}
      {chips.length ? chips.map((c) => <CategoryChip key={c.value} label={c.label} slot={c.slot!} />)
        : <span className="inline-flex items-center gap-1 text-down-ink"><Icon icon={FailedIcon} className="size-4" />Nobody picked yet</span>}
    </span>
  );
}

type CardProps = {
  level: Level; index: number; count: number; options: Options;
  /** This card is open to edit; `readOnly` = the version shown can't be edited (no Edit). */
  editing: boolean; readOnly: boolean;
  /** Done was pressed with a group that names nobody: its error shows (never while the user is still picking). */
  checked: boolean;
  onChange: (l: Level) => void; onEdit: () => void; onDone: () => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
};

/**
 * One level as a card (audit W1–W5): the same header row in read and edit mode (number, "Level N · name", Edit, or
 * Done and ⋯), so opening it moves nothing above or beside it; the body cross-fades. Editing, every row sits on the
 * EditorRow grid: the name, then each group in a tray block (how many · who, chips in the field · X), "and" between
 * groups, "Add a group" under the main column.
 */
export function LevelCard({ level: l, index: i, count, options, editing, readOnly, checked, onChange, onEdit, onDone, onMove, onRemove }: CardProps) {
  const id = useId();
  const n = i + 1;
  const empty = checked ? emptyGroups(l) : [];
  const [added, setAdded] = useState<number | null>(null); // the group just added enters; the others don't replay it
  const setGroup = (gi: number, g: Group) => onChange({ ...l, groups: l.groups.map((x, j) => (j === gi ? g : x)) });
  return (
    <li data-slot="level-card" data-mode={editing ? "edit" : "read"} className="grid rounded-lg border border-line bg-card shadow-xs">
      <div data-slot="level-head" className="flex min-h-12 items-center gap-3 px-4 py-2">
        <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full text-label tabular transition-colors duration-(--dur-fast)",
          editing ? "bg-primary text-primary-foreground" : "bg-primary-soft text-primary")}>{n}</span>
        <h3 className="min-w-0 flex-1 truncate text-label text-fg">{`Level ${n}${l.name ? ` · ${l.name}` : ""}`}</h3>
        {editing ? (
          <span className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="edit" size="sm" data-focus="done" onClick={onDone}>Done</Button>
            <ActionMenu label={`Actions for level ${n}`} actions={[
              { id: "up", label: "Move up", disabled: i === 0, hint: i === 0 ? "It is the first level." : undefined, onSelect: () => onMove(-1) },
              { id: "down", label: "Move down", disabled: i === count - 1, hint: i === count - 1 ? "It is the last level." : undefined, onSelect: () => onMove(1) },
              { id: "remove", label: "Remove level", destructive: true, disabled: count === 1, hint: count === 1 ? "A workflow needs at least one level." : undefined, onSelect: onRemove },
            ]} />
          </span>
        ) : !readOnly && (
          <Button type="button" variant="edit" size="sm" aria-label={`Edit level ${n}`} data-focus="edit" onClick={onEdit}><Icon icon={EditIcon} />Edit</Button>
        )}
      </div>
      <div key={editing ? "edit" : "read"} data-slot="level-body" className="grid animate-fade gap-2 border-t border-line px-4 py-3">
        {!editing ? l.groups.map((g, gi) => (
          <Fragment key={gi}>{gi > 0 && <And />}<GroupLine g={g} options={options} /></Fragment>
        )) : <>
          <EditorRow className="px-2" lead={<label htmlFor={`${id}-name`} className="flex h-8 items-center text-label text-fg">Name<span className="ml-1 font-normal text-fg-3">(optional)</span></label>}>
            <Input id={`${id}-name`} data-focus="name" placeholder="Treasury head" value={l.name} maxLength={80} onChange={(e) => onChange({ ...l, name: e.target.value })} />
          </EditorRow>
          {l.groups.map((g, gi) => {
            const label = `Level ${n}, group ${gi + 1}`;
            const bad = empty.includes(gi);
            return (
              <Fragment key={gi}>
                {gi > 0 && <And />}
                <div data-slot="group-block" className={cn("relative rounded-md bg-tray p-2 max-md:pr-11", gi === added && "animate-enter")}>
                  <EditorRow
                    lead={<NeedPicker need={g.need} label={`${label}: how many approve`} onChange={(need) => setGroup(gi, { ...g, need })} />}
                    trailing={
                      <Button type="button" variant="remove" size="icon" aria-label={`Remove group ${gi + 1} of level ${n}`} disabled={l.groups.length === 1}
                        className={cn("max-md:absolute max-md:top-2 max-md:right-2", l.groups.length === 1 && "invisible")}
                        onClick={() => onChange({ ...l, groups: l.groups.filter((_, j) => j !== gi) })}><Icon icon={CloseIcon} /></Button>
                    }>
                    <div className="grid gap-1">
                      <ApproverPicker g={g} options={options} label={`${label}: approvers`} invalid={bad} describedBy={bad ? `${id}-g${gi}-e` : undefined}
                        onChange={(ng) => setGroup(gi, ng)} />
                      {bad && <span id={`${id}-g${gi}-e`} role="alert" className="text-body-sm text-down-ink">Pick who approves this group.</span>}
                    </div>
                  </EditorRow>
                </div>
              </Fragment>
            );
          })}
          {l.groups.length < GROUPS_MAX && (
            <EditorRow className="px-2" lead={null}>
              <Button type="button" variant="create" size="sm" onClick={() => { setAdded(l.groups.length); onChange({ ...l, groups: [...l.groups, newGroup()] }); }}>
                <Icon icon={AddIcon} />Add a group that must also approve
              </Button>
            </EditorRow>
          )}
        </>}
      </div>
    </li>
  );
}

/**
 * A workflow's levels as cards, approvals in order top to bottom. One level is open to edit at a time: Done, Edit on
 * another card and "Add level" all close it only once every group names someone, else it stays open and says which
 * group needs a pick. Adding a level opens it. Moving and removing a level sit in the open card's ⋯ menu; removing
 * asks first. `reveal` (a count, raised by a blocked Send) opens the first level with a group naming nobody, with its
 * error. Focus follows: the button that replaced the one pressed, the moved card's ⋯, the card after a removed one.
 */
export function Levels({ levels, onChange, options, disabled, reveal = 0 }: { levels: Level[]; onChange: (l: Level[]) => void; options: Options; disabled: boolean; reveal?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const [checked, setChecked] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // where focus goes once the change is on screen: card index + selector (a new object each time, so the same target again counts)
  const [want, focus] = useReducer((_: { i: number; on: string } | null, next: { i: number; on: string }) => next, null);
  const editing = disabled ? null : open;
  useEffect(() => {
    if (!want) return;
    // a task later: a closing menu or dialog puts focus back on its (gone) trigger first
    setTimeout(() => listRef.current?.children[want.i]?.querySelector<HTMLElement>(want.on)?.focus(), 0);
  }, [want]);
  /** The open level may close only when every group names someone; else it stays open with its error. */
  const mayLeave = () => {
    if (editing === null || !levels[editing] || !emptyGroups(levels[editing]).length) return true;
    setChecked(editing); focus({ i: editing, on: '[aria-invalid="true"]' });
    return false;
  };
  const openLevel = (i: number | null) => {
    if (!mayLeave()) return;
    setOpen(i); setChecked(null);
    focus({ i: i ?? editing ?? 0, on: i === null ? '[data-focus="edit"]' : '[data-focus="done"]' });
  };
  const [seen, setSeen] = useState(reveal);
  if (reveal !== seen) {
    setSeen(reveal);
    const at = editing !== null && levels[editing] && emptyGroups(levels[editing]).length ? editing : levels.findIndex((l) => emptyGroups(l).length);
    if (at >= 0 && !disabled) { setOpen(at); setChecked(at); focus({ i: at, on: '[aria-invalid="true"]' }); }
  }
  const setLevel = (i: number, l: Level) => onChange(levels.map((x, j) => (j === i ? l : x)));
  const move = (i: number, d: -1 | 1) => { onChange(arrayMove(levels, i, i + d)); setOpen(i + d); setChecked(null); focus({ i: i + d, on: '[data-slot="action-menu-trigger"]' }); };
  const gone = removing === null ? null : levels[removing];
  const removedAt = useRef<number | null>(null);
  return (
    <>
      <ol ref={listRef} className="grid gap-3" aria-label="Levels in order">
        {levels.map((l, i) => (
          <LevelCard key={i} level={l} index={i} count={levels.length} options={options} editing={editing === i} readOnly={disabled} checked={checked === i}
            onChange={(x) => setLevel(i, x)} onEdit={() => openLevel(i)} onMove={(d) => move(i, d)} onRemove={() => setRemoving(i)}
            onDone={() => openLevel(null)} />
        ))}
      </ol>
      {!disabled && levels.length < LEVELS_MAX && (
        <Button type="button" variant="create" size="sm" className="justify-self-start"
          onClick={() => { if (!mayLeave()) return; onChange([...levels, newLevel()]); setOpen(levels.length); setChecked(null); focus({ i: levels.length, on: '[data-focus="name"]' }); }}>
          <Icon icon={AddIcon} />Add level {levels.length + 1}
        </Button>
      )}
      {gone && removing !== null && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setRemoving(null); }} auditFields={false} reasons={[]} destructive
          title={`Remove level ${removing + 1}`} description="The level and who approves at it go from this draft. The levels after it move up."
          impact={[
            `Level ${removing + 1}${gone.name ? ` · ${gone.name}` : ""}: ${plural(gone.groups.length, "group", "groups")}`,
            "Recons that use this workflow keep the version they picked until they move to a new one.",
          ]}
          actionLabel="Remove level"
          onCloseAutoFocus={(e) => {
            // opened from a menu item that is gone: removed → the card now there (or the one before), kept → its ⋯
            e.preventDefault();
            const at = removedAt.current, cards = listRef.current?.children;
            removedAt.current = null;
            if (at === null) cards?.[removing]?.querySelector<HTMLElement>('[data-slot="action-menu-trigger"]')?.focus();
            else (cards?.[at] ?? cards?.[at - 1])?.querySelector<HTMLElement>('[data-focus="edit"]')?.focus();
          }}
          onConfirm={async () => { removedAt.current = removing; onChange(levels.filter((_, j) => j !== removing)); setOpen(null); setChecked(null); }} />
      )}
    </>
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
