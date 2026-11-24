"use client";

import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { EditToggle, Field, Panel, SectionHeading } from "@starterkit/ui/ds";
import { Table, TableBody, TableCell, TableExpandRow, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { APPROVAL_FIELDS, buildCatalog, type CatalogField, type Condition, conditionFields, conditionText } from "@starterkit/shared/conditions";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconApprovalSpec, ReconSpec, WorkflowRef } from "@starterkit/shared/contracts/recon";
import type { LibraryRowDto, PreviewDto } from "@starterkit/shared/contracts/workflows";
import { DEFAULT_CHAIN_TEXT, RULES_MAX, type Trigger, TRIGGER_LABEL, TRIGGERS } from "@starterkit/shared/workflows";
import { SortableList } from "@/components/sortable-list";
import { movedIndex } from "@/components/sortable-model";
import { api, errorText } from "@/lib/client/api";
import { workflowOptions } from "@/lib/shared/queries-recon";
import { approvalRow, condDone, keptCopy, ruleDone, savable } from "./approval-model";
import dynamic from "next/dynamic";
import { ConditionEditor } from "./condition-editor";

// the actions editor, mapper and tables load after the step (first-load budget, DEC-040)
const ActionsEditor = dynamic(() => import("./actions-editor").then((m) => m.ActionsEditor), { ssr: false, loading: () => <span className="text-body-sm text-fg-3">Loading actions…</span> });
const SetupTables = dynamic(() => import("./setup-tables").then((m) => m.SetupTables), { ssr: false });
import type { Fields } from "./spec-model";

// The setup's Approval step (DEC-052 rev 2 §4.4, Figma 06 Rules frames): per change, the workflow that approves it in
// this recon (the default chain unless one is picked), and rules that pick another workflow in some cases. A picked
// workflow pins its live version; a newer live version is offered, never taken on its own.

type Setup = NonNullable<ReconApprovalSpec["changes"][Trigger]>;
type Rule = Setup["workflow"]["rules"][number];

/** "Version 3 is newer · Use it" beside a pin older than the workflow's live version. */
function Newer({ pin, rows, onUse, disabled }: { pin: WorkflowRef; rows: readonly LibraryRowDto[]; onUse: (v: number) => void; disabled: boolean }) {
  const live = rows.find((r) => r.id === pin.id)?.published?.version;
  if (!live || live <= pin.version) return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-caption text-degraded-ink">
      Uses version {pin.version}. Version {live} is newer.
      {!disabled && <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onUse(live)}>Use version {live}</Button>}
    </span>
  );
}

/** A workflow picker: the default chain first, then the space's live workflows (a pinned one that is gone stays listed). */
function WorkflowSelect({ value, rows, onChange, label, disabled, allowDefault }: {
  value: WorkflowRef | null; rows: readonly LibraryRowDto[]; onChange: (v: WorkflowRef | null) => void; label: string; disabled: boolean; allowDefault: boolean;
}) {
  const live = rows.filter((r) => r.published && !r.archived);
  const known = !value || live.some((r) => r.id === value.id);
  return (
    <Select aria-label={label} value={value?.id ?? ""} disabled={disabled} className="min-w-0 md:max-w-sm"
      onChange={(e) => { const r = live.find((x) => x.id === e.target.value); onChange(r ? { id: r.id, version: r.published!.version } : null); }}>
      {allowDefault ? <option value="">{DEFAULT_CHAIN_TEXT}</option> : <option value="" disabled>Pick a workflow</option>}
      {!known && <option value={value!.id}>{rows.find((r) => r.id === value!.id)?.name ?? "A workflow no longer available"}</option>}
      {live.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.levels} {r.levels === 1 ? "level" : "levels"}</option>)}
    </Select>
  );
}

/** One change's editor, opened in place under its table row: who approves every request, rules that pick another workflow in some cases, then what is sent to the bank. */
function ChangeEditor({ kind, recon, setup, onChange, rows, catalog, disabled, children }: {
  kind: Trigger; recon: string; setup: Setup; onChange: (s: Setup) => void; rows: readonly LibraryRowDto[]; catalog: readonly CatalogField[]; disabled: boolean;
  /** What is sent to the bank on its approval events (stage 4). */
  children?: React.ReactNode;
}) {
  const w = setup.workflow;
  const setRules = (rules: Rule[]) => onChange({ ...setup, workflow: { ...w, rules } });
  const setRule = (i: number, r: Rule) => setRules(w.rules.map((x, j) => (j === i ? r : x)));
  const [open, setOpen] = useState<number | null>(null);
  const change = TRIGGER_LABEL[kind].toLowerCase();
  return (
      <div className="grid gap-6 rounded-lg bg-tray p-4 motion-safe:animate-enter">
        <section className="grid gap-4">
        <SectionHeading n={1} level={3} title="Who approves" description="The workflow every request goes through; rules can pick another one in some cases" />
        <div className="grid gap-1.5">
          <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
            {w.rules.length ? `Every other ${change} in ${recon} is approved by` : `Every ${change} in ${recon} is approved by`}
            <WorkflowSelect value={w.default} rows={rows} disabled={disabled} allowDefault label={`${TRIGGER_LABEL[kind]}: workflow for every request`}
              onChange={(d) => onChange({ ...setup, workflow: { ...w, default: d } })} />
          </span>
          {w.default && <Newer pin={w.default} rows={rows} disabled={disabled} onUse={(v) => onChange({ ...setup, workflow: { ...w, default: { ...w.default!, version: v } } })} />}
        </div>
        {w.rules.length > 0 && (
          <SortableList items={w.rules} noun="Rule" label={`${TRIGGER_LABEL[kind]}: rules, first match wins`} disabled={disabled} className="gap-list"
            itemClassName="grid gap-2 rounded-lg border border-line-strong bg-card p-3 shadow-xs motion-safe:animate-enter"
            onReorder={(next, from, to) => { setRules(next); if (open !== null) setOpen(movedIndex(open, from, to)); }}
            renderItem={(r, { index: i, handle }) => (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-body-sm">
                    {handle}
                    <span className="min-w-0">
                    <span className="text-label text-fg">{r.name.trim() || `Rule ${i + 1}`}</span>
                    {open !== i && <span className="text-fg-2"> · {condDone(r.when as Condition) ? conditionText(r.when as Condition, catalog) : "unfinished"} → {rows.find((x) => x.id === r.workflow.id)?.name ?? "pick a workflow"}</span>}
                    </span>
                  </span>
                  {!disabled && (
                    <span className="flex shrink-0 items-center gap-1">
                      <EditToggle open={open === i} onToggle={() => setOpen(open === i ? null : i)} name={`rule ${i + 1}`} />
                      <Button type="button" variant="remove" size="icon-sm" aria-label={`Remove rule ${i + 1}`} onClick={() => { setRules(w.rules.filter((_, j) => j !== i)); setOpen(null); }}><Icon icon={RemoveIcon} /></Button>
                    </span>
                  )}
                </div>
                {open === i && !disabled && (
                  <div className="grid gap-3">
                    <Field id={`rule-${kind}-${i}`} label="Rule name" required>
                      <Input id={`rule-${kind}-${i}`} value={r.name} maxLength={80} placeholder="Large RTGS" className="md:max-w-sm" onChange={(e) => setRule(i, { ...r, name: e.target.value })} />
                    </Field>
                    <ConditionEditor value={r.when} catalog={catalog} disabled={false} label={`Rule ${i + 1}: conditions`} onChange={(when) => setRule(i, { ...r, when: when as Rule["when"] })} />
                    <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
                      Then approved by
                      <WorkflowSelect value={r.workflow.id ? r.workflow : null} rows={rows} disabled={false} allowDefault={false} label={`Rule ${i + 1}: workflow`}
                        onChange={(v) => v && setRule(i, { ...r, workflow: v })} />
                    </span>
                    {r.workflow.id && <Newer pin={r.workflow} rows={rows} disabled={false} onUse={(v) => setRule(i, { ...r, workflow: { ...r.workflow, version: v } })} />}
                  </div>
                )}
              </>
            )} />
        )}
        {!disabled && w.rules.length < RULES_MAX && (
          <Button type="button" variant="create" size="sm" className="justify-self-start"
            onClick={() => { setRules([...w.rules, { name: "", when: { all: [{ field: "", op: "eq", value: "" }] }, workflow: { id: "", version: 1 } }]); setOpen(w.rules.length); }}>
            <Icon icon={AddIcon} />Add a rule for some cases
          </Button>
        )}
        </section>
        {children && (
          <section className="grid gap-4 border-t border-line-strong pt-6">
            <SectionHeading n={2} level={3} title="What is sent to the bank" description="Actions that run on this change's approval events, through an Open API connector" />
            {children}
          </section>
        )}
      </div>
  );
}

/**
 * The four changes as one table (S2): Change → Who approves → Sent to bank, each row with Edit that opens its editor in
 * place under it (one at a time). The shared table (audit 2 B6): flush to the card, DataTable's header and cells, the
 * editor in a TableExpandRow (12 under its row, 16 at the sides and bottom), Edit ↔ Done one size (EditToggle).
 * Below 768 px each change is a card: its name and the toggle on the first line, the two values under it.
 */
function ChangesTable({ local, rows, editor, disabled }: {
  local: ReconApprovalSpec; rows: readonly LibraryRowDto[]; editor: (k: Trigger) => React.ReactNode; disabled: boolean;
}) {
  const [open, setOpen] = useState<Trigger | null>(null);
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? null;
  const CARD = "max-md:h-auto max-md:border-b-0 max-md:p-0";
  return (
    <Panel flush title="Who approves each change" description="Every request goes through its workflow; once approved, its actions send it to the bank">
      <Table aria-label="Who approves each change" className="max-md:block">
        <TableHeader className="max-md:hidden">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="w-44">Change</TableHead>
            <TableHead scope="col">Who approves</TableHead>
            <TableHead scope="col">Sent to bank</TableHead>
            <TableHead scope="col" className="w-px"><span className="sr-only">Edit</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-md:grid max-md:grid-cols-[minmax(0,1fr)]">
          {TRIGGERS.map((k) => {
            const s = local.changes[k];
            const r = approvalRow(s, nameOf);
            const unfinished = (s?.workflow.rules ?? []).some((x) => !ruleDone(x));
            const isOpen = open === k;
            return (
              <Fragment key={k}>
                <TableRow data-expanded={isOpen || undefined} className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:border-b max-md:border-line max-md:px-3 max-md:py-3 max-md:data-[expanded]:border-b-0">
                  <TableHead scope="row" className={`h-(--row-h) border-b border-line text-body font-medium text-fg ${CARD}`}>{TRIGGER_LABEL[k]}</TableHead>
                  <TableCell className={`text-fg max-md:col-span-2 max-md:row-start-2 ${CARD}`}>
                    <span className="text-body-sm text-fg-3 md:hidden">Who approves: </span>{r.who}
                    {unfinished && <span className="block text-body-sm text-degraded-ink">A rule is unfinished</span>}
                  </TableCell>
                  <TableCell className={`text-fg max-md:col-span-2 max-md:row-start-3 ${CARD}`}>
                    <span className="text-body-sm text-fg-3 md:hidden">Sent to bank: </span>{r.bank}
                  </TableCell>
                  <TableCell className={`text-right whitespace-nowrap max-md:col-start-2 max-md:row-start-1 ${CARD}`}>
                    <EditToggle open={isOpen} readOnly={disabled} onToggle={() => setOpen(isOpen ? null : k)} name={TRIGGER_LABEL[k].toLowerCase()} />
                  </TableCell>
                </TableRow>
                {isOpen && <TableExpandRow colSpan={4} className="max-md:block max-md:px-3 max-md:pt-0">{editor(k)}</TableExpandRow>}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Panel>
  );
}

/** Who would approve: a change and the values of the fields the rules read → the rule, the workflow and its people. */
function WhoApproves({ spaceId, configId, versionId, approvals, catalog, dirty }: {
  spaceId: string; configId: string; versionId: string; approvals: ReconApprovalSpec; catalog: readonly CatalogField[]; dirty: boolean;
}) {
  const [kind, setKind] = useState<Trigger>("unmatch");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: PreviewDto } | { error: string } | null>(null);
  const used = [...new Set((approvals.changes[kind]?.workflow.rules ?? []).flatMap((r) => conditionFields(r.when)))].filter((k) => k);
  async function run() {
    setBusy(true);
    try {
      const ok = await api<PreviewDto>(`/api/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}/versions/${encodeURIComponent(versionId)}/approvals/preview`, {
        method: "POST", body: JSON.stringify({ change: kind, values: Object.fromEntries(used.map((k) => [k, values[k] ?? ""]).filter(([, v]) => v)) }),
      });
      setRes({ ok });
    } catch (e) { setRes({ error: errorText(e) }); } finally { setBusy(false); }
  }
  return (
    <Panel title="Try who approves" description="Pick a change and enter values to see which rule picks and who would approve">
      <div className="grid gap-3">
        <Select aria-label="Change to try" value={kind} onChange={(e) => { setKind(e.target.value as Trigger); setRes(null); }}>
          {TRIGGERS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
        </Select>
        {used.map((k) => (
          <Field key={k} id={`try-${k}`} label={catalog.find((f) => f.key === k)?.label ?? "A field no longer read"}>
            <Input id={`try-${k}`} value={values[k] ?? ""} maxLength={200} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
          </Field>
        ))}
        <Button type="button" variant="secondary" className="justify-self-start" onClick={() => void run()} disabled={busy || dirty} aria-busy={busy || undefined}>
          {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Show who approves
        </Button>
        {dirty && <span className="text-caption text-fg-3">Shows the saved draft: wait for the change to save.</span>}
        <div role="status" className="grid gap-2">
          {res && "error" in res && <span className="text-body-sm text-down-ink">{res.error}</span>}
          {res && "ok" in res && (
            <>
              <span className="text-body-sm text-fg">
                {res.ok.rule.index === null ? res.ok.rule.name === "Default" ? "The default chain" : `Every request · ${res.ok.workflow?.name}` : `Rule “${res.ok.rule.name}” · ${res.ok.workflow?.name}`}
                {res.ok.workflow ? ` · version ${res.ok.workflow.version}` : ""}
              </span>
              <ol className="grid gap-1.5">
                {res.ok.levels.map((l, i) => (
                  <li key={i} className="grid gap-0.5 motion-safe:animate-enter">
                    <span className="text-label text-fg">Level {i + 1}{l.name && l.name !== `Level ${i + 1}` ? ` · ${l.name}` : ""}</span>
                    {l.groups.map((g, gi) => (
                      <span key={gi} className={g.short ? "text-caption text-down-ink" : "text-caption text-fg-2"}>
                        {g.approvers.length ? g.approvers.map((p) => p.name ?? "A removed user").join(", ") : "Nobody can approve this level yet"}
                      </span>
                    ))}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

/**
 * The Approval step. Unfinished rules stay on screen and out of the saved draft until they are complete (they hold the
 * step and the submit); the step is optional (no setup = the default chain for every change).
 */
export function ApprovalStep({ spaceId, configId, versionId, recon, spec, fields, onChange, onUnfinished, disabled, dirty }: {
  spaceId: string; configId: string; versionId: string; recon: string; spec: ReconSpec; fields: Fields;
  onChange: (approvals: ReconApprovalSpec | undefined) => void; onUnfinished: (open: boolean) => void; disabled: boolean; dirty: boolean;
}) {
  const q = workflowOptions(spaceId);
  const wf = useQuery({ queryKey: q.key, queryFn: () => api<Page<LibraryRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows?pageSize=100&sort=name`) });
  const rows = wf.data?.items ?? [];
  const catalog = useMemo(() => buildCatalog([
    { label: spec.sides[0].label, fields: fields[0] ?? new Map() }, { label: spec.sides[1].label, fields: fields[1] ?? new Map() },
  ]), [fields, spec.sides]);
  // finished parts save into the draft as they change; an unfinished rule (the contract refuses it) is kept in this
  // browser per draft with the saved setup it was based on, and comes back on reload only while that still holds
  const key = `recon-approval-draft:${versionId}`;
  const [local, setLocal] = useState<ReconApprovalSpec>(spec.approvals ?? { accounts: [], lookups: [], changes: {} });
  useEffect(() => {
    if (disabled) return;
    let stored: string | null = null;
    try { stored = localStorage.getItem(key); } catch { /* storage off: start from the draft */ }
    const kept = keptCopy(stored, spec.approvals);
    if (kept) setLocal(kept as ReconApprovalSpec); // eslint-disable-line react-hooks/set-state-in-effect -- browser storage is read after mount, so the server render matches
    else if (stored) try { localStorage.removeItem(key); } catch { /* storage off */ }
  }, [key, disabled]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per draft; later saves come from this step
  const { unfinished } = savable(local);
  useEffect(() => { onUnfinished(unfinished); }, [unfinished, onUnfinished]);
  function set(next: ReconApprovalSpec) {
    setLocal(next);
    const r = savable(next);
    try {
      if (r.unfinished) localStorage.setItem(key, JSON.stringify({ base: JSON.stringify(r.approvals ?? null), approvals: next }));
      else localStorage.removeItem(key);
    } catch { /* storage off: kept until the page goes */ }
    onChange(r.approvals);
  }
  const empty: Setup = { workflow: { default: null, rules: [] }, actions: [] };
  const actionCatalog = useMemo(() => [...catalog, ...APPROVAL_FIELDS], [catalog]);
  return (
    <div className="grid gap-section">
      <div className="grid min-w-0 gap-section">
        {wf.error && <p role="alert" className="text-body-sm text-down-ink">Couldn&apos;t load the space&apos;s workflows. {errorText(wf.error)}</p>}
        {unfinished && <p role="status" className="text-body-sm text-degraded-ink">A rule is unfinished: name it, complete its conditions and pick its workflow, or remove it. The rest is saved.</p>}
        <ChangesTable local={local} rows={rows} disabled={disabled} editor={(k) => (
          <ChangeEditor kind={k} recon={recon} setup={local.changes[k] ?? empty} rows={rows} catalog={catalog} disabled={disabled}
            onChange={(s) => set({ ...local, changes: { ...local.changes, [k]: s } })}>
            <ActionsEditor kind={k} changeLabel={TRIGGER_LABEL[k]} actions={(local.changes[k] ?? empty).actions ?? []} spaceId={spaceId} configId={configId} versionId={versionId}
              catalog={actionCatalog} setup={{ accounts: local.accounts ?? [], lookups: local.lookups ?? [] }} disabled={disabled}
              onChange={(actions) => set({ ...local, changes: { ...local.changes, [k]: { ...(local.changes[k] ?? empty), actions } } })} />
          </ChangeEditor>
        )} />
        <SetupTables accounts={local.accounts ?? []} lookups={local.lookups ?? []} disabled={disabled} onChange={(accounts, lookups) => set({ ...local, accounts, lookups })} />

      </div>
      <div className="min-w-0">
        <WhoApproves spaceId={spaceId} configId={configId} versionId={versionId} approvals={local} catalog={catalog} dirty={dirty || unfinished} />
      </div>
    </div>
  );
}
