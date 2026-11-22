"use client";

// One approval action in a full-screen editor (owner 22 Nov: "oke full screen", "seperti setup ERD"): settings on the
// left in numbered sections (the action, its variants, the variant open), the field map in the middle (canvas, or the
// list), the field open on the right (where its value comes from, its changes, a sample from a real break), and What
// gets posted under the map. Edits stay here until Done; Cancel drops them; Escape closes only when nothing changed.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { BlockedButton, Combobox, Field, ScrollFade, SectionHeading } from "@starterkit/ui/ds";
import { FullScreenEditor } from "@starterkit/ui/ds/full-screen-editor";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, ArrowDownIcon, ArrowUpIcon, CloseIcon, RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActionPreviewDto, ActionSpec, VariantSpec } from "@starterkit/shared/contracts/recon";
import { type CatalogField, type Condition, conditionText } from "@starterkit/shared/conditions";
import { readPath } from "@starterkit/shared/integrations";
import type { Source } from "@starterkit/shared/mapping";
import type { Trigger } from "@starterkit/shared/workflows";
import { api, errorText } from "@/lib/client/api";
import { reconBreaksQuery } from "@/lib/shared/queries-recon";
import { EventPicker, type Ops, opOf, OperationPicker } from "./action-parts";
import { condDone } from "./approval-model";
import { ChangeChips } from "./change-chips";
import { ConditionEditor } from "./condition-editor";
import { connect, keepMapping, mapGraph } from "./field-map";
import { FieldMapCanvas } from "./field-map-canvas";
import { Mapper } from "./mapper";

type Account = { key: string; label: string; number: string; currency: string };
type Setup = { accounts: readonly Account[]; lookups: readonly { name: string }[] };
const GROUP = { break: "Break", recon: "Recon", side_a: "Side A", side_b: "Side B", approval: "Approval" } as const;
const KIND_LABEL = { field: "A recon field", const: "A fixed value", template: "A template", lookup: "A lookup table", account: "An account" } as const;
const blankClause = { all: [{ field: "", op: "eq", value: "" }] } as const;

/** Why Done is refused, or null. */
export function unfinishedReason(a: ActionSpec): string | null {
  if (!a.name.trim()) return "Name the action first.";
  const v = a.variants.findIndex((x) => !x.name.trim() || !x.operation.key || (x.when && !condDone(x.when as Condition)));
  if (v < 0) return null;
  const x = a.variants[v]!;
  return !x.name.trim() ? `Name variant ${v + 1}.` : !x.operation.key ? `Pick where ${x.name} sends to.` : `Finish the conditions of ${x.name}.`;
}

/** The field open in the inspector: where its value comes from, its changes, a sample. */
function FieldInspector({ path, graph, source, onChange, onClose, catalog, setup, sample }: {
  path: string; graph: ReturnType<typeof mapGraph>; source: Source | undefined;
  onChange: (s: Source | undefined) => void; onClose: () => void; catalog: readonly CatalogField[]; setup: Setup; sample: { value: unknown; from: string } | null;
}) {
  const row = graph.request.find((r) => r.path === path)!;
  const kind = source?.kind ?? "none";
  const fieldPick = (v: string | undefined, set: (k: string) => void, label: string) => (
    <Combobox label={label} value={v ? [v] : []} placeholder="Pick a recon field" searchPlaceholder="Search fields"
      options={catalog.map((f) => ({ value: f.key, label: f.label, group: GROUP[f.group] }))} onValueChange={([k]) => k && set(k)} />
  );
  return (
    <div className="grid gap-5">
      <SectionHeading level={3} title={row.name} description={path !== row.name ? <span className="font-mono">{path}</span> : "A field of the request"}
        actions={<>
          {source && <Button type="button" variant="remove" size="icon" aria-label={`Remove the mapping of ${row.name}`} title="Remove mapping" onClick={() => onChange(undefined)}><Icon icon={RemoveIcon} /></Button>}
          <Button type="button" variant="ghost" size="icon" aria-label="Close this field" title="Close" onClick={onClose}><Icon icon={CloseIcon} /></Button>
        </>} />
      <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line-strong bg-card p-3 text-body-sm">
        <dt className="text-fg-3">Required</dt><dd className={row.required ? "text-down-ink" : "text-fg"}>{row.required ? "Yes" : "No"}</dd>
        <dt className="text-fg-3">Type</dt><dd className="text-fg">{row.type}</dd>
      </dl>
      <Field id="src-kind" label="Its value comes from">
        <Select id="src-kind" value={kind} onChange={(e) => {
          const k = e.target.value;
          onChange(k === "field" ? { kind: "field", key: catalog[0]?.key ?? "break.amount", transforms: [] } : k === "const" ? { kind: "const", value: "" } : k === "template" ? { kind: "template", text: "" }
            : k === "lookup" ? { kind: "lookup", table: setup.lookups[0]?.name ?? "", key: { kind: "field", key: catalog[0]?.key ?? "break.amount", transforms: [] } }
              : k === "account" ? { kind: "account", account: setup.accounts[0]?.key ?? "", part: "number" } : undefined);
        }}>
          <option value="none">Not mapped yet</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k} disabled={(k === "lookup" && !setup.lookups.length) || (k === "account" && !setup.accounts.length)}>{l}</option>)}
        </Select>
      </Field>
      {source?.kind === "field" && (
        <>
          {fieldPick(source.key, (key) => onChange({ ...source, key }), "Recon field")}
          <div className="grid gap-1.5"><span className="text-label text-fg">Changes, in order</span>
            <ChangeChips label="Changes" value={source.transforms} onChange={(transforms) => onChange({ ...source, transforms })} /></div>
        </>
      )}
      {source?.kind === "const" && <Field id="src-const" label="Fixed value"><Input id="src-const" value={source.value} maxLength={500} onChange={(e) => onChange({ ...source, value: e.target.value })} /></Field>}
      {source?.kind === "template" && (
        <div className="grid gap-2">
          <Field id="src-tpl" label="Template" note="Recon fields in braces, joined with any text you type between them; changes after |, e.g. {break.business_date|date:yyMMdd}">
            <Input id="src-tpl" value={source.text} maxLength={500} className="font-mono" onChange={(e) => onChange({ ...source, text: e.target.value })} />
          </Field>
          <Combobox label="Insert a recon field" value={[]} placeholder="Insert a recon field at the end" searchPlaceholder="Search fields"
            options={[...catalog.map((f) => ({ value: f.key, label: f.label, group: GROUP[f.group] })), ...setup.accounts.map((x) => ({ value: `accounts.${x.key}.number`, label: `${x.label || x.key} number`, group: "Accounts" }))]}
            onValueChange={([k]) => k && onChange({ ...source, text: `${source.text}{${k}}` })} />
        </div>
      )}
      {source?.kind === "lookup" && (
        <>
          <Field id="src-lt" label="Lookup table"><Select id="src-lt" value={source.table} onChange={(e) => onChange({ ...source, table: e.target.value })}>{setup.lookups.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}</Select></Field>
          {fieldPick(source.key.kind === "field" ? source.key.key : undefined, (key) => onChange({ ...source, key: { kind: "field", key, transforms: [] } }), "Looked up by")}
          <Field id="src-fb" label="When not found (optional)"><Input id="src-fb" value={source.fallback ?? ""} onChange={(e) => { const { fallback: _, ...rest } = source; onChange(e.target.value ? { ...rest, fallback: e.target.value } : rest); }} /></Field>
        </>
      )}
      {source?.kind === "account" && (
        <div className="grid grid-cols-2 gap-2">
          <Field id="src-acc" label="Account"><Select id="src-acc" value={source.account} onChange={(e) => onChange({ ...source, account: e.target.value })}>{setup.accounts.map((a) => <option key={a.key} value={a.key}>{a.label || a.key}</option>)}</Select></Field>
          <Field id="src-part" label="Part"><Select id="src-part" value={source.part} onChange={(e) => onChange({ ...source, part: e.target.value as "number" | "label" | "currency" })}><option value="number">Number</option><option value="label">Name</option><option value="currency">Currency</option></Select></Field>
        </div>
      )}
      <div className="grid gap-1 rounded-lg border border-line-strong bg-tray p-3">
        <span className="text-label text-fg">Sample</span>
        {sample ? <span className="break-all font-mono text-body-sm text-fg">{sample.value === undefined || sample.value === "" ? "(empty)" : JSON.stringify(sample.value)}</span>
          : <span className="text-body-sm text-fg-3">Pick a break under the map and show what gets posted to see this field&apos;s value.</span>}
        {sample && <span className="text-caption text-fg-3">From {sample.from}</span>}
      </div>
    </div>
  );
}

/**
 * What gets posted for a real break, from the action as it stands in the editor: the first break is picked when the
 * editor opens and the preview runs again shortly after each change, so the map's examples stay live.
 */
function Dock({ spaceId, configId, versionId, change, index, draft, onResult }: {
  spaceId: string; configId: string; versionId: string; change: Trigger; index: number; draft: ActionSpec;
  onResult: (r: ActionPreviewDto | null, from: string) => void;
}) {
  const q = reconBreaksQuery(spaceId, configId);
  const breaks = useQuery({ queryKey: q.key, queryFn: () => api<Page<BreakRowDto>>(q.url) });
  const rows = breaks.data?.items ?? [];
  const [chosen, setItem] = useState("");
  const item = chosen || rows[0]?.id || "";
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ActionPreviewDto | { error: string } | null>(null);
  const name = (id: string) => { const b = rows.find((x) => x.id === id); return b ? `${b.ref ?? "No reference"} · ${b.businessDate}` : "a break"; };
  const body = JSON.stringify({ change, action: index, itemId: item, draft });
  useEffect(() => {
    if (!item) return;
    let gone = false;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<ActionPreviewDto>(`/api/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(configId)}/versions/${encodeURIComponent(versionId)}/actions/preview`, { method: "POST", body });
        if (!gone) { setRes(r); onResult(r, name(item)); }
      } catch (e) { if (!gone) { setRes({ error: errorText(e) }); onResult(null, ""); } } finally { if (!gone) setBusy(false); }
    }, 500);
    return () => { gone = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);
  return (
    <div className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeading level={3} title="What gets posted" description="Built from a real break as you edit, masked as the bank's spec masks it" className="min-w-0 flex-1" />
        {rows.length > 0 && (
          <span className="flex items-center gap-2">
            {busy && <Icon icon={SpinnerIcon} className="text-fg-3 motion-safe:animate-spin" aria-label="Updating" />}
            <Select aria-label="Break to try" value={item} className="w-72" onChange={(e) => setItem(e.target.value)}>
              {rows.map((b) => <option key={b.id} value={b.id}>{b.ref ?? "No reference"} · {b.businessDate} · {b.reason ?? ""}</option>)}
            </Select>
          </span>
        )}
      </div>
      {!rows.length && <span className="text-body-sm text-fg-3">{breaks.isPending ? "Loading breaks…" : "This recon has no open break to try it with yet. Breaks appear after its first run."}</span>}
      <div role="status" className="grid gap-2">
        {res && "error" in res && <span className="text-body-sm text-down-ink">{res.error}</span>}
        {res && "variant" in res && (
          <>
            <span className={cn("text-body-sm", res.problem ? "text-down-ink" : "text-healthy-ink")}>
              {res.variant ? `Variant “${res.variant}”` : "No variant fits"}{res.problem ? ` · ${res.problem.message}` : " · ready to send"}
            </span>
            {res.payload !== null && (
              <ScrollFade className="max-h-56 rounded-md border border-line-strong bg-card" tabIndex={0} aria-label="Payload">
                <pre className="p-3 font-mono text-caption text-fg">{JSON.stringify(res.payload, null, 2)}</pre>
              </ScrollFade>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ActionScreen({ open, initial, changeLabel, ops, catalog, setup, spaceId, configId, versionId, change, index, onDone, onCancel }: {
  open: boolean; initial: ActionSpec; changeLabel: string; ops: Ops; catalog: readonly CatalogField[]; setup: Setup;
  spaceId: string; configId: string; versionId: string; change: Trigger; index: number; onDone: (a: ActionSpec) => void; onCancel: () => void;
}) {
  const [a, setA] = useState<ActionSpec>(initial);
  const [vi, setVi] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [held, setHeld] = useState(false);
  const [sample, setSample] = useState<{ payload: unknown; context: Record<string, unknown>; from: string } | null>(null);
  const v = a.variants[vi]!;
  const setV = (next: VariantSpec) => setA({ ...a, variants: a.variants.map((x, j) => (j === vi ? next : x)) });
  const { op, connector } = opOf(ops, v.operation);
  const graph = useMemo(() => (op ? mapGraph(v.mapping, catalog, op, setup.accounts) : null), [v.mapping, catalog, op, setup.accounts]);
  const blocked = unfinishedReason(a);
  const dirty = a !== initial;
  const move = (d: -1 | 1) => { const vs = [...a.variants]; [vs[vi + d], vs[vi]] = [vs[vi]!, vs[vi + d]!]; setA({ ...a, variants: vs }); setVi(vi + d); };
  const setSource = (path: string, s: Source | undefined) => { const { [path]: _, ...rest } = v.mapping; setV({ ...v, mapping: s ? { ...rest, [path]: s } : rest }); };

  const rail = (
    <div className="grid gap-7">
      <section className="grid gap-3">
        <SectionHeading n={1} level={3} title="Action" description="What it does and when it runs" />
        <Field id="act-name" label="Name" required><Input id="act-name" value={a.name} maxLength={80} placeholder="Post to GL" onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
        <Field id="act-kind" label="Kind">
          <Select id="act-kind" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as ActionSpec["kind"] })}>
            <option value="posting">Posting</option><option value="notify">Notify</option>
          </Select>
        </Field>
        <span className="text-caption text-fg-3">{a.kind === "posting" ? "A posting marks the break's posting result." : "A notify only shows on the timeline."}</span>
        <Field id="act-when" label="Runs"><EventPicker value={a.on} onChange={(on) => setA({ ...a, on })} label="Action" /></Field>
      </section>
      <section className="grid gap-3 border-t border-line-strong pt-5">
        <SectionHeading n={2} level={3} title="Variants" description="First match wins" />
        <ol className="grid gap-1.5">
          {a.variants.map((x, i) => (
            <li key={i}>
              <button type="button" aria-current={i === vi || undefined} onClick={() => { setVi(i); setPicked(null); }}
                className={cn("grid w-full gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-primary",
                  i === vi ? "border-primary bg-primary-soft" : "border-line-strong bg-card hover:bg-tray")}>
                <span className="flex items-center gap-2 text-body-sm text-fg"><span className="text-caption text-fg-3 tabular">{i + 1}</span>{x.name || "Unnamed"}</span>
                <span className="truncate text-caption text-fg-3">{x.when ? conditionText(x.when as Condition, catalog) : "Every break"} → {opOf(ops, x.operation).op?.name ?? "nowhere yet"}</span>
              </button>
            </li>
          ))}
        </ol>
        {a.variants.length < 20 && (
          <Button type="button" variant="add" size="sm" className="justify-self-start" onClick={() => { setA({ ...a, variants: [...a.variants, { ...v, name: `Variant ${a.variants.length + 1}`, when: blankClause, mapping: {} } as unknown as VariantSpec] }); setVi(a.variants.length); setPicked(null); }}>
              <Icon icon={AddIcon} />Add a variant
            </Button>
        )}
      </section>
      <section className="grid gap-3 border-t border-line-strong pt-5">
        <SectionHeading n={3} level={3} title={v.name || "This variant"} description="Its breaks and where it sends"
          actions={<span className="flex">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move this variant earlier" disabled={vi === 0} onClick={() => move(-1)}><Icon icon={ArrowUpIcon} /></Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move this variant later" disabled={vi === a.variants.length - 1} onClick={() => move(1)}><Icon icon={ArrowDownIcon} /></Button>
            <Button type="button" variant="remove" size="icon-sm" aria-label="Remove this variant" disabled={a.variants.length === 1} onClick={() => { setA({ ...a, variants: a.variants.filter((_, j) => j !== vi) }); setVi(0); setPicked(null); }}><Icon icon={RemoveIcon} /></Button>
          </span>} />
        <Field id="var-name" label="Variant name" required><Input id="var-name" value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <Field id="var-for" label="Use it for">
          <Select id="var-for" value={v.when ? "some" : "every"} onChange={(e) => setV({ ...v, when: e.target.value === "every" ? null : blankClause } as unknown as VariantSpec)}>
            <option value="every">Every break</option><option value="some">Breaks where…</option>
          </Select>
        </Field>
        {v.when && <ConditionEditor value={v.when as Condition} catalog={catalog} disabled={false} label="Variant conditions" onChange={(when) => setV({ ...v, when: when as VariantSpec["when"] })} />}
        <Field id="var-op" label="Sends to" required>
          <OperationPicker stacked value={v.operation.connectorId ? v.operation : null} ops={ops} label="Variant"
            onChange={(operation) => { const o = opOf(ops, operation).op; setV({ ...v, operation, mapping: o ? keepMapping(v.mapping, o) : {} }); setPicked(null); }} />
        </Field>
        <Field id="var-per" label="A force match with several breaks">
          <Select id="var-per" value={v.per} onChange={(e) => setV({ ...v, per: e.target.value as VariantSpec["per"] })}><option value="item">One call per break</option><option value="request">One call for the request</option></Select>
        </Field>
        <Field id="var-zero" label="An amount of 0">
          <Select id="var-zero" value={v.zeroOrNegative} onChange={(e) => setV({ ...v, zeroOrNegative: e.target.value as VariantSpec["zeroOrNegative"] })}><option value="skip">Skip it, nothing to post</option><option value="absolute_swap">Post it anyway</option></Select>
        </Field>
      </section>
    </div>
  );

  const inspector = graph && picked && graph.request.some((r) => r.path === picked && r.leaf) ? (
    <FieldInspector path={picked} graph={graph} source={v.mapping[picked]} onChange={(s) => setSource(picked, s)} onClose={() => setPicked(null)} catalog={catalog} setup={setup}
      sample={sample ? { value: readPath(sample.payload, picked), from: sample.from } : null} />
  ) : undefined;

  // what the map's dots mean, and how to draw a line: on the map itself (the inspector opens only with a field)
  const legend = (
    <div className="pointer-events-none absolute right-3 bottom-3 z-10 grid gap-1 rounded-md border border-line-strong bg-card/95 px-3 py-2 text-caption text-fg-2 shadow-sm">
      <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2.5 rounded-full bg-primary" />Mapped</span>
      <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2.5 rounded-full border-2 border-down-mark bg-card" />Required, still empty</span>
      <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2.5 rounded-full bg-line-strong" />Optional, empty</span>
      <span className="text-fg-3">Drag from a recon field&apos;s dot to a request field&apos;s dot. Click a field or a line to edit it.</span>
    </div>
  );
  const status = graph && (
    <div className={cn("pointer-events-none absolute top-3 left-3 z-10 max-w-[70%] rounded-md border px-3 py-1.5 text-body-sm shadow-sm",
      graph.missing.length ? "border-down-mark bg-down-soft text-down-ink" : "border-healthy-mark bg-healthy-soft text-healthy-ink")} role="status">
      {graph.missing.length ? `${graph.missing.length} required ${graph.missing.length === 1 ? "field" : "fields"} still empty: ${graph.missing.join(", ")}` : "Every required field is filled"}
    </div>
  );

  return (
    <FullScreenEditor open={open} title={a.name.trim() || "New action"} description={`${changeLabel} · ${opOf(ops, v.operation).op ? `${connector?.name} · ${op!.name}` : "pick where it sends to"}`}
      onOpenChange={(o) => { if (!o) { if (dirty) setHeld(true); else onCancel(); } }}
      actions={<>
        {held && <span role="status" className="text-body-sm text-degraded-ink">Use Cancel to drop your changes, or Done to keep them.</span>}
        <span className="flex rounded-md border border-line-strong bg-tray p-0.5 max-md:hidden" role="group" aria-label="View">
          {(["canvas", "list"] as const).map((x) => (
            <Button key={x} type="button" size="sm" variant={view === x ? "secondary" : "ghost"} aria-pressed={view === x} onClick={() => setView(x)}>{x === "canvas" ? "Map" : "List"}</Button>
          ))}
        </span>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <BlockedButton reason={blocked} caption={false} onClick={() => onDone({ ...a, name: a.name.trim(), variants: a.variants.map((x) => ({ ...x, name: x.name.trim() })) })}>Done</BlockedButton>
      </>}
      rail={rail} inspector={inspector}
      dock={<Dock spaceId={spaceId} configId={configId} versionId={versionId} change={change} index={index} draft={a} onResult={(r, from) => setSample(r ? { payload: r.payload, context: r.context, from } : null)} />}>
      {!op || !graph ? (
        <div className="grid h-full place-items-center p-8 text-center">
          <span className="grid max-w-sm gap-1.5">
            <span className="text-title-3 text-fg">Pick where it sends to</span>
            <span className="text-body-sm text-fg-3">Choose the connector and operation under 3 in the settings. Its request fields appear here to map.</span>
          </span>
        </div>
      ) : (
        <>
          {status}
          {view === "canvas" && <span className="max-md:hidden">{legend}</span>}
          <div className={cn("absolute inset-0", view === "list" ? "hidden" : "max-md:hidden")}>
            <FieldMapCanvas graph={graph} title="Request" caption={`${op.name} · ${op.method} ${op.path}`} selected={picked} onSelect={setPicked}
              onConnect={(row, target) => { const m = connect(v.mapping, row, target, op); if (m) { setV({ ...v, mapping: m }); setPicked(target); } }}
              onRemove={(target) => setSource(target, undefined)} examples={sample} />
          </div>
          <div className={cn("scroll-quiet absolute inset-0 overflow-y-auto p-5 pt-14", view === "canvas" && "md:hidden")}>
            <Mapper mapping={v.mapping} onChange={(mapping) => setV({ ...v, mapping })} op={op} catalog={catalog} setup={setup} disabled={false} />
          </div>
        </>
      )}
    </FullScreenEditor>
  );
}
