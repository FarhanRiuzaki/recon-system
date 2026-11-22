"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Field, Panel } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowDownIcon, ArrowUpIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { buildCatalog, type CatalogField, type Clause, type Condition, conditionFields, conditionText, NO_VALUE_OPS } from "@starterkit/shared/conditions";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconApprovalSpec, ReconSpec, WorkflowRef } from "@starterkit/shared/contracts/recon";
import type { LibraryRowDto, PreviewDto } from "@starterkit/shared/contracts/workflows";
import { type Trigger, TRIGGER_LABEL, TRIGGERS } from "@starterkit/shared/workflows";
import { api, errorText } from "@/lib/client/api";
import { workflowOptions } from "@/lib/shared/queries-recon";
import { ConditionEditor } from "./condition-editor";
import type { Fields } from "./spec-model";

// The setup's Approval step (DEC-052 rev 2 §4.4, Figma 06 Rules frames): per change, the workflow that approves it in
// this recon (the default chain unless one is picked), and rules that pick another workflow in some cases. A picked
// workflow pins its live version; a newer live version is offered, never taken on its own.

type Setup = NonNullable<ReconApprovalSpec["changes"][Trigger]>;
type Rule = Setup["workflow"]["rules"][number];
const RULES_MAX = 20;
const DEFAULT_TEXT = "Default · 1 of Reviewer or Space admin";

const clauseDone = (c: Clause) => !!c.field && (NO_VALUE_OPS.includes(c.op) || (Array.isArray(c.value) ? c.value.some((v) => v.trim()) : !!c.value?.trim()));
const condDone = (c: Condition): boolean => { const p = "all" in c ? c.all : c.any; return p.length > 0 && p.every((x) => ("field" in x ? clauseDone(x) : condDone(x))); };
/** The setup as the contract takes it, or null while a rule is unfinished (it stays on screen, unsaved). */
function complete(a: ReconApprovalSpec): ReconApprovalSpec | null {
  const changes: ReconApprovalSpec["changes"] = {};
  for (const k of TRIGGERS) {
    const s = a.changes[k];
    if (!s) continue;
    if (s.workflow.rules.some((r) => !r.name.trim() || !condDone(r.when) || !r.workflow.id)) return null;
    // a change left on the default chain with no rules says nothing: it goes
    if (!s.workflow.default && !s.workflow.rules.length) continue;
    changes[k] = { workflow: { default: s.workflow.default, rules: s.workflow.rules.map((r) => ({ ...r, name: r.name.trim() })) } };
  }
  return { changes };
}

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
      {allowDefault ? <option value="">{DEFAULT_TEXT}</option> : <option value="" disabled>Pick a workflow</option>}
      {!known && <option value={value!.id}>{rows.find((r) => r.id === value!.id)?.name ?? "A workflow no longer available"}</option>}
      {live.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.levels} {r.levels === 1 ? "level" : "levels"}</option>)}
    </Select>
  );
}

/** One change's card: who approves every request, then rules that pick another workflow in some cases. */
function ChangeCard({ kind, recon, setup, onChange, rows, catalog, disabled }: {
  kind: Trigger; recon: string; setup: Setup; onChange: (s: Setup) => void; rows: readonly LibraryRowDto[]; catalog: readonly CatalogField[]; disabled: boolean;
}) {
  const w = setup.workflow;
  const setRules = (rules: Rule[]) => onChange({ workflow: { ...w, rules } });
  const setRule = (i: number, r: Rule) => setRules(w.rules.map((x, j) => (j === i ? r : x)));
  const [open, setOpen] = useState<number | null>(null);
  const change = TRIGGER_LABEL[kind].toLowerCase();
  return (
    <Panel title={TRIGGER_LABEL[kind]}>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
            {w.rules.length ? `Every other ${change} in ${recon} is approved by` : `Every ${change} in ${recon} is approved by`}
            <WorkflowSelect value={w.default} rows={rows} disabled={disabled} allowDefault label={`${TRIGGER_LABEL[kind]}: workflow for every request`}
              onChange={(d) => onChange({ workflow: { ...w, default: d } })} />
          </span>
          {w.default && <Newer pin={w.default} rows={rows} disabled={disabled} onUse={(v) => onChange({ workflow: { ...w, default: { ...w.default!, version: v } } })} />}
        </div>
        {w.rules.length > 0 && (
          <ol className="grid gap-2" aria-label={`${TRIGGER_LABEL[kind]}: rules, first match wins`}>
            {w.rules.map((r, i) => (
              <li key={i} className="grid gap-2 rounded-lg border border-line bg-card p-3 motion-safe:animate-enter">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-body-sm">
                    <span className="text-label text-fg">{r.name.trim() || `Rule ${i + 1}`}</span>
                    {open !== i && <span className="text-fg-2"> · {condDone(r.when) ? conditionText(r.when, catalog) : "unfinished"} → {rows.find((x) => x.id === r.workflow.id)?.name ?? "pick a workflow"}</span>}
                  </span>
                  {!disabled && (
                    <span className="flex shrink-0 items-center">
                      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(open === i ? null : i)}>{open === i ? "Done" : "Edit"}</Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => setRules(w.rules.map((x, j) => (j === i - 1 ? w.rules[i]! : j === i ? w.rules[i - 1]! : x)))}><Icon icon={ArrowUpIcon} /></Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Move rule ${i + 1} down`} disabled={i === w.rules.length - 1} onClick={() => setRules(w.rules.map((x, j) => (j === i + 1 ? w.rules[i]! : j === i ? w.rules[i + 1]! : x)))}><Icon icon={ArrowDownIcon} /></Button>
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove rule ${i + 1}`} onClick={() => { setRules(w.rules.filter((_, j) => j !== i)); setOpen(null); }}><Icon icon={RemoveIcon} /></Button>
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
              </li>
            ))}
          </ol>
        )}
        {!disabled && w.rules.length < RULES_MAX && (
          <button type="button" className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-body-sm text-fg-2 transition-colors duration-(--dur-fast) hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => { setRules([...w.rules, { name: "", when: { all: [{ field: "", op: "eq", value: "" }] }, workflow: { id: "", version: 1 } }]); setOpen(w.rules.length); }}>
            Use another workflow in some cases
          </button>
        )}
      </div>
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
    <Panel title="Who approves" description="Try values to see which rule picks and who would approve">
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
 * The Approval step. Unfinished rules stay on screen and out of the saved draft until they are complete; the step is
 * optional (no setup = the default chain for every change).
 */
export function ApprovalStep({ spaceId, configId, versionId, recon, spec, fields, onChange, disabled, dirty }: {
  spaceId: string; configId: string; versionId: string; recon: string; spec: ReconSpec; fields: Fields;
  onChange: (approvals: ReconApprovalSpec | undefined) => void; disabled: boolean; dirty: boolean;
}) {
  const q = workflowOptions(spaceId);
  const wf = useQuery({ queryKey: q.key, queryFn: () => api<Page<LibraryRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/workflows?pageSize=100&sort=name`) });
  const rows = wf.data?.items ?? [];
  const catalog = useMemo(() => buildCatalog([
    { label: spec.sides[0].label, fields: fields[0] ?? new Map() }, { label: spec.sides[1].label, fields: fields[1] ?? new Map() },
  ]), [fields, spec.sides]);
  // an unfinished rule can't be saved in the draft (the contract refuses it): it is kept in this browser per draft, so a
  // reload brings it back; dropped once the setup is complete again
  const key = `recon-approval-draft:${versionId}`;
  const [local, setLocal] = useState<ReconApprovalSpec>(() => {
    try { const kept = localStorage.getItem(key); if (kept) return JSON.parse(kept) as ReconApprovalSpec; } catch { /* storage off: start from the draft */ }
    return spec.approvals ?? { changes: {} };
  });
  const unfinished = complete(local) === null;
  function set(next: ReconApprovalSpec) {
    setLocal(next);
    const done = complete(next);
    try { if (done) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage off: kept until the page goes */ }
    if (done) onChange(Object.keys(done.changes).length ? done : undefined);
  }
  const empty: Setup = { workflow: { default: null, rules: [] } };
  return (
    <div className="grid gap-section">
      <div className="grid min-w-0 gap-section">
        {wf.error && <p role="alert" className="text-body-sm text-down-ink">Couldn&apos;t load the space&apos;s workflows. {errorText(wf.error)}</p>}
        {unfinished && <p role="status" className="text-body-sm text-degraded-ink">A rule is unfinished: name it, complete its conditions and pick its workflow to save it.</p>}
        {TRIGGERS.map((k) => (
          <ChangeCard key={k} kind={k} recon={recon} setup={local.changes[k] ?? empty} rows={rows} catalog={catalog} disabled={disabled}
            onChange={(s) => set({ changes: { ...local.changes, [k]: s } })} />
        ))}
      </div>
      <div className="min-w-0">
        <WhoApproves spaceId={spaceId} configId={configId} versionId={versionId} approvals={local} catalog={catalog} dirty={dirty || unfinished} />
      </div>
    </div>
  );
}
