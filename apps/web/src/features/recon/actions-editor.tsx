"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Field, ScrollFade } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowDownIcon, ArrowUpIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ConnectorOperationsDto } from "@starterkit/shared/contracts/integrations";
import type { ActionPreviewDto, ActionSpec, VariantSpec } from "@starterkit/shared/contracts/recon";
import { type CatalogField, type Condition, conditionText } from "@starterkit/shared/conditions";
import { type Trigger, TRIGGER_LABEL } from "@starterkit/shared/workflows";
import { api, errorText } from "@/lib/client/api";
import { connectorOperationsQuery, reconBreaksQuery } from "@/lib/shared/queries-recon";
import { actionSentence, mappingGaps } from "./actions-model";
import { condDone } from "./approval-model";
import { ConditionEditor } from "./condition-editor";
import { Mapper } from "./mapper";

// A change's actions in the Approval step (stage 4, design §4.4–4.5): "When level N approves / when the change is
// approved / rejected, post or send <action>", each with variants (the first whose condition holds, none = every
// break), an operation of a connector's reviewed version, and the mapper. A new action starts from a short form; an
// action is edited in its panel and applied with Done, so an unfinished condition never reaches the saved draft.

type Ops = ConnectorOperationsDto["items"];
type Setup = { accounts: readonly { key: string; label: string }[]; lookups: readonly { name: string }[] };
const opOf = (ops: Ops, ref: VariantSpec["operation"]) => {
  const c = ops.find((x) => x.id === ref.connectorId);
  const v = c?.versions.find((x) => x.version === ref.version);
  return { connector: c, version: v, op: v?.operations.find((o) => o.key === ref.key) };
};

/** Connector, version (published once) and operation, as one select each. */
function OperationPicker({ value, onChange, ops, label }: { value: VariantSpec["operation"] | null; onChange: (v: VariantSpec["operation"]) => void; ops: Ops; label: string }) {
  const c = ops.find((x) => x.id === value?.connectorId);
  const v = c?.versions.find((x) => x.version === value?.version);
  const live = (cc: Ops[number]) => cc.versions.find((x) => x.live) ?? cc.versions[0]!;
  return (
    <span className="grid gap-2 md:grid-cols-3">
      <Select aria-label={`${label}: connector`} value={c?.id ?? ""} onChange={(e) => { const cc = ops.find((x) => x.id === e.target.value); if (cc) onChange({ connectorId: cc.id, version: live(cc).version, key: live(cc).operations[0]?.key ?? "" }); }}>
        {!c && <option value="">Pick a connector</option>}
        {ops.map((x) => <option key={x.id} value={x.id}>{x.name}{x.disabled ? " (turned off)" : ""}</option>)}
      </Select>
      <Select aria-label={`${label}: version`} value={v?.version ?? ""} disabled={!c} onChange={(e) => { const vv = c?.versions.find((x) => x.version === Number(e.target.value)); if (c && vv) onChange({ connectorId: c.id, version: vv.version, key: vv.operations.find((o) => o.key === value?.key)?.key ?? vv.operations[0]?.key ?? "" }); }}>
        {c?.versions.map((x) => <option key={x.version} value={x.version}>Version {x.version}{x.live ? " (live)" : ""}</option>)}
      </Select>
      <Select aria-label={`${label}: operation`} value={value?.key ?? ""} disabled={!v} onChange={(e) => c && v && onChange({ connectorId: c.id, version: v.version, key: e.target.value })}>
        {v?.operations.map((o) => <option key={o.key} value={o.key}>{o.name} · {o.method} {o.path}</option>)}
      </Select>
    </span>
  );
}

const EVENTS = [{ value: "approved", label: "When the change is approved" }, { value: "level_approved", label: "When a level approves" }, { value: "rejected", label: "When the change is rejected" }] as const;
function EventPicker({ value, onChange, label }: { value: ActionSpec["on"]; onChange: (v: ActionSpec["on"]) => void; label: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select aria-label={`${label}: when`} value={value.event} className="w-60" onChange={(e) => onChange(e.target.value === "level_approved" ? { event: "level_approved", level: 1 } : { event: e.target.value as "approved" | "rejected" })}>
        {EVENTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </Select>
      {value.event === "level_approved" && (
        <Input aria-label={`${label}: level`} type="number" min={1} max={10} value={value.level} className="w-20" onChange={(e) => onChange({ event: "level_approved", level: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })} />
      )}
    </span>
  );
}

/** What gets posted: a real break of the recon, the variant that fits, the payload (masked) and each field's source. */
function Preview({ spaceId, configId, versionId, change, index, dirty }: { spaceId: string; configId: string; versionId: string; change: Trigger; index: number; dirty: boolean }) {
  const q = reconBreaksQuery(spaceId, configId);
  const breaks = useQuery({ queryKey: q.key, queryFn: () => api<Page<BreakRowDto>>(`/api/spaces/${encodeURIComponent(spaceId)}/breaks?recon=${encodeURIComponent(configId)}&pageSize=25`) });
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ActionPreviewDto | { error: string } | null>(null);
  async function run() {
    setBusy(true);
    try {
      setRes(await api<ActionPreviewDto>(`/api/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}/versions/${encodeURIComponent(versionId)}/actions/preview`, {
        method: "POST", body: JSON.stringify({ change, action: index, itemId: item }),
      }));
    } catch (e) { setRes({ error: errorText(e) }); } finally { setBusy(false); }
  }
  const rows = breaks.data?.items ?? [];
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-tray p-3">
      <span className="text-label text-fg">What gets posted</span>
      {!rows.length ? <span className="text-body-sm text-fg-3">{breaks.isPending ? "Loading breaks…" : "This recon has no open break to try it with yet."}</span> : (
        <span className="flex flex-wrap items-center gap-2">
          <Select aria-label="Break to try" value={item} className="w-72" onChange={(e) => { setItem(e.target.value); setRes(null); }}>
            <option value="">Pick a break</option>
            {rows.map((b) => <option key={b.id} value={b.id}>{b.ref ?? "No reference"} · {b.businessDate} · {b.reason ?? ""}</option>)}
          </Select>
          <Button type="button" variant="secondary" size="sm" disabled={!item || busy || dirty} aria-busy={busy || undefined} onClick={() => void run()}>
            {busy && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Show what gets posted
          </Button>
          {dirty && <span className="text-caption text-fg-3">Shows the saved draft: wait for the change to save.</span>}
        </span>
      )}
      <div role="status" className="grid gap-2">
        {res && "error" in res && <span className="text-body-sm text-down-ink">{res.error}</span>}
        {res && "variant" in res && (
          <>
            <span className="text-body-sm text-fg">{res.variant ? `Variant “${res.variant}”` : "No variant fits"}{res.problem ? ` · ${res.problem.message}` : ""}</span>
            {res.payload !== null && (
              <div className="grid gap-2 md:grid-cols-2">
                <ScrollFade className="max-h-72 rounded-md border border-line bg-card" tabIndex={0} aria-label="Payload">
                  <pre className="p-3 font-mono text-caption text-fg">{JSON.stringify(res.payload, null, 2)}</pre>
                </ScrollFade>
                <dl className="grid content-start gap-1 text-caption">
                  {Object.entries(res.sources).map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="font-mono text-fg">{k}</dt><dd className="text-fg-3">{v}</dd></div>)}
                </dl>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One action open to edit; Done applies it (refused while a variant's condition is unfinished). */
function ActionPanel({ initial, onDone, onCancel, ops, catalog, setup, preview }: {
  initial: ActionSpec; onDone: (a: ActionSpec) => void; onCancel: () => void; ops: Ops; catalog: readonly CatalogField[]; setup: Setup;
  preview: (index: number) => React.ReactNode;
}) {
  const [a, setA] = useState<ActionSpec>(initial);
  const [vi, setVi] = useState(0);
  const setV = (i: number, v: VariantSpec) => setA({ ...a, variants: a.variants.map((x, j) => (j === i ? v : x)) });
  const v = a.variants[vi]!;
  const { op } = opOf(ops, v.operation);
  const unfinished = a.variants.some((x) => x.when && !condDone(x.when as Condition)) || !a.name.trim();
  return (
    <div className="grid gap-4 rounded-lg border border-line bg-card p-4 motion-safe:animate-enter">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <Field id="act-name" label="Action name" required>
          <Input id="act-name" value={a.name} maxLength={80} onChange={(e) => setA({ ...a, name: e.target.value })} />
        </Field>
        <Field id="act-kind" label="Kind">
          <Select id="act-kind" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as ActionSpec["kind"] })}>
            <option value="posting">Posting (marks the break&apos;s posting result)</option>
            <option value="notify">Notify (shown on the timeline)</option>
          </Select>
        </Field>
      </div>
      <EventPicker value={a.on} onChange={(on) => setA({ ...a, on })} label="Action" />
      <div className="grid gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-label text-fg">Variants</span>
          <span className="text-caption text-fg-3">The first whose condition holds is used.</span>
        </span>
        <ul className="flex flex-wrap gap-1.5">
          {a.variants.map((x, i) => (
            <li key={i}>
              <Button type="button" size="sm" variant={i === vi ? "secondary" : "ghost"} onClick={() => setVi(i)}>{x.name || `Variant ${i + 1}`}</Button>
            </li>
          ))}
          {a.variants.length < 20 && (
            <li><Button type="button" size="sm" variant="ghost" onClick={() => { setA({ ...a, variants: [...a.variants, { ...v, name: `Variant ${a.variants.length + 1}`, when: { all: [{ field: "", op: "eq", value: "" }] }, mapping: {} } as VariantSpec] }); setVi(a.variants.length); }}>Add a variant</Button></li>
          )}
        </ul>
      </div>
      <div className="grid gap-4 border-t border-line pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field id="var-name" label="Variant name" required>
            <Input id="var-name" value={v.name} maxLength={80} onChange={(e) => setV(vi, { ...v, name: e.target.value })} className="md:w-64" />
          </Field>
          <span className="flex">
            <Button type="button" variant="ghost" size="icon" aria-label="Move this variant earlier" disabled={vi === 0} onClick={() => { const vs = [...a.variants]; [vs[vi - 1], vs[vi]] = [vs[vi]!, vs[vi - 1]!]; setA({ ...a, variants: vs }); setVi(vi - 1); }}><Icon icon={ArrowUpIcon} /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Move this variant later" disabled={vi === a.variants.length - 1} onClick={() => { const vs = [...a.variants]; [vs[vi + 1], vs[vi]] = [vs[vi]!, vs[vi + 1]!]; setA({ ...a, variants: vs }); setVi(vi + 1); }}><Icon icon={ArrowDownIcon} /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Remove this variant" disabled={a.variants.length === 1} onClick={() => { setA({ ...a, variants: a.variants.filter((_, j) => j !== vi) }); setVi(0); }}><Icon icon={RemoveIcon} /></Button>
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-2 text-body-sm text-fg-2">
          Use it for
          <Select aria-label="Which breaks" value={v.when ? "some" : "every"} className="w-48" onChange={(e) => setV(vi, { ...v, when: e.target.value === "every" ? null : { all: [{ field: "", op: "eq", value: "" }] } } as VariantSpec)}>
            <option value="every">every break</option>
            <option value="some">breaks where…</option>
          </Select>
        </span>
        {v.when && <ConditionEditor value={v.when as Condition} catalog={catalog} disabled={false} label="Variant conditions" onChange={(when) => setV(vi, { ...v, when: when as VariantSpec["when"] })} />}
        <Field id="var-op" label="Send to">
          <OperationPicker value={v.operation.connectorId ? v.operation : null} ops={ops} label="Variant" onChange={(operation) => setV(vi, { ...v, operation, mapping: {} })} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="var-per" label="A force match with several breaks">
            <Select id="var-per" value={v.per} onChange={(e) => setV(vi, { ...v, per: e.target.value as VariantSpec["per"] })}>
              <option value="item">One call per break</option>
              <option value="request">One call for the request</option>
            </Select>
          </Field>
          <Field id="var-zero" label="An amount of 0">
            <Select id="var-zero" value={v.zeroOrNegative} onChange={(e) => setV(vi, { ...v, zeroOrNegative: e.target.value as VariantSpec["zeroOrNegative"] })}>
              <option value="skip">Skip it (nothing to post)</option>
              <option value="absolute_swap">Post it anyway</option>
            </Select>
          </Field>
        </div>
        {op ? (
          <>
            {mappingGaps(v.mapping, op).length > 0 && <span role="status" className="text-body-sm text-down-ink">Still to fill: {mappingGaps(v.mapping, op).join(", ")}</span>}
            <Mapper mapping={v.mapping} onChange={(mapping) => setV(vi, { ...v, mapping })} op={op} catalog={catalog} setup={setup} disabled={false} />
          </>
        ) : <span className="text-body-sm text-fg-3">Pick where it sends to, then map its fields.</span>}
        {preview(vi)}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {unfinished && <span className="text-caption text-degraded-ink">Name it and finish every variant&apos;s condition to apply it.</span>}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" disabled={unfinished} onClick={() => onDone({ ...a, name: a.name.trim(), variants: a.variants.map((x) => ({ ...x, name: x.name.trim() || "Variant" })) })}>Done</Button>
      </div>
    </div>
  );
}

/** A change's actions: sentences, Add an action (name, when, where it sends), and the panel of the one open. */
export function ActionsEditor({ kind, actions, onChange, spaceId, configId, versionId, catalog, setup, disabled, dirty }: {
  kind: Trigger; actions: readonly ActionSpec[]; onChange: (a: ActionSpec[]) => void; spaceId: string; configId: string; versionId: string;
  catalog: readonly CatalogField[]; setup: Setup; disabled: boolean; dirty: boolean;
}) {
  const q = connectorOperationsQuery(spaceId);
  const opsQ = useQuery({ queryKey: q.key, queryFn: () => api<ConnectorOperationsDto>(`/api/spaces/${encodeURIComponent(spaceId)}/connector-operations`) });
  const ops = opsQ.data?.items ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ name: string; on: ActionSpec["on"]; operation: VariantSpec["operation"] | null } | null>(null);
  const change = TRIGGER_LABEL[kind].toLowerCase();
  return (
    <div className="grid gap-2">
      <span className="text-label text-fg">Send to the bank</span>
      {actions.length === 0 && !adding && <span className="text-body-sm text-fg-3">Nothing is sent when a {change} is approved. Add an action to post or tell the bank.</span>}
      <ol className="grid gap-2">
        {actions.map((a, i) => (
          <li key={i} className="grid gap-2">
            {open === i ? (
              <ActionPanel initial={a} ops={ops} catalog={catalog} setup={setup} onCancel={() => setOpen(null)}
                onDone={(next) => { onChange(actions.map((x, j) => (j === i ? next : x))); setOpen(null); }}
                preview={() => <Preview spaceId={spaceId} configId={configId} versionId={versionId} change={kind} index={i} dirty={dirty} />} />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2">
                <span className="grid min-w-0">
                  <span className="text-body-sm text-fg">{actionSentence(a)}</span>
                  <span className="truncate text-caption text-fg-3">
                    {a.variants.map((v) => `${v.name}: ${v.when ? conditionText(v.when as Condition, catalog) : "every break"} → ${opOf(ops, v.operation).op?.name ?? v.operation.key}`).join(" · ")}
                  </span>
                </span>
                {!disabled && (
                  <span className="flex shrink-0">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(i)}>Edit</Button>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${a.name}`} onClick={() => onChange(actions.filter((_, j) => j !== i))}><Icon icon={RemoveIcon} /></Button>
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {adding && (
        <div className="grid gap-3 rounded-lg border border-line bg-card p-4 motion-safe:animate-enter">
          <Field id="new-act" label="Action name" required>
            <Input id="new-act" value={adding.name} maxLength={80} placeholder="Post to GL" onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </Field>
          <EventPicker value={adding.on} onChange={(on) => setAdding({ ...adding, on })} label="New action" />
          <Field id="new-op" label="Send to">
            {ops.length ? <OperationPicker value={adding.operation} ops={ops} label="New action" onChange={(operation) => setAdding({ ...adding, operation })} />
              : <span className="text-body-sm text-fg-3">{opsQ.isPending ? "Loading…" : "No connector is published yet. An Open API manager adds one under Access → Open API."}</span>}
          </Field>
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
            <Button type="button" disabled={!adding.name.trim() || !adding.operation?.key} onClick={() => {
              onChange([...actions, { name: adding.name.trim(), kind: "posting", on: adding.on, variants: [{ name: "Default", when: null, operation: adding.operation!, mapping: {}, per: "item", zeroOrNegative: "skip" }] } as ActionSpec]);
              setAdding(null); setOpen(actions.length);
            }}>Add action</Button>
          </span>
        </div>
      )}
      {!disabled && !adding && actions.length < 10 && (
        <button type="button" onClick={() => setAdding({ name: "", on: { event: "approved" }, operation: null })}
          className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-body-sm text-fg-2 transition-colors duration-(--dur-fast) hover:bg-tray focus-visible:outline-2 focus-visible:outline-primary">
          Add an action
        </button>
      )}
    </div>
  );
}
