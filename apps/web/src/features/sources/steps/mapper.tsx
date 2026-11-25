"use client";

// The source mapper (DEC-059): the file's columns and the core record on one full-screen canvas, the field map the
// recon posting mapper draws. A line is a column feeding a core field; the inspector sets a preset, a formula or a fixed
// currency; the rail keeps columns as extra attributes. Edits stay in the mapper until Done; Cancel drops them.
import { useMemo, useState } from "react";
import { Checkbox } from "@starterkit/ui/ds/checkbox";
import { Field } from "@starterkit/ui/ds/field";
import { FullScreenEditor } from "@starterkit/ui/ds/full-screen-editor";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { FieldMapCanvas } from "@/components/field-map/canvas";
import { CORE_ROWS, type CoreRow, connect, disconnect, setSource, sourceGraph, summaryLine, toggleAttr } from "../mapper-model";
import { useSpecPreview } from "../use-spec-preview";

/** Past this many columns the rail offers a search. */
const SEARCH_FROM = 30;
const isCore = (k: string | null): k is CoreRow => !!k && (CORE_ROWS as readonly string[]).includes(k);

type PreviewOf = { spaceId: string; ids: { sourceId: string; versionId: string } | null; file: boolean; sampleId: string | null; sample: string; fileName: string; businessDate: string };

/** What feeds core row `k` as the inspector's select value. */
function sourceValue(spec: SourceSpec, k: CoreRow): string {
  const r = (spec.mapping as unknown as Record<string, { field: string } | { cel: string } | undefined>)[k];
  if (k === "currency" && !r && spec.currency) return "const";
  if (!r) return "";
  if ("field" in r) return `field:${r.field}`;
  return r.cel === "file_date" || r.cel === "arrived_date" ? `preset:${r.cel}` : "cel";
}

export function SourceMapper({ open, name, spec: given, examples, preview, onDone, onCancel }: {
  open: boolean; name: string; spec: SourceSpec; examples: Readonly<Record<string, string>>; preview: PreviewOf;
  onDone: (spec: SourceSpec) => void; onCancel: () => void;
}) {
  const [spec, setSpec] = useState(given);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const graph = useMemo(() => sourceGraph(spec, examples), [spec, examples]);
  const live = useSpecPreview({ ...preview, spec, enabled: open });
  const edit = (next: SourceSpec) => { setRefused(null); setSpec(next); };
  const remove = (k: string) => {
    if (!isCore(k)) return;
    const r = disconnect(spec, k);
    if ("refused" in r) setRefused(r.refused); else edit(r);
  };
  const columns = spec.fields.filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()));
  const attrOf = (col: string) => Object.entries(spec.mapping.attrs ?? {}).find(([, r]) => "field" in r && r.field === col)?.[0];
  const row = isCore(selected) ? graph.request.find((r) => r.path === selected) : undefined;

  const rail = (
    <div className="grid gap-3 p-3">
      {spec.fields.length > SEARCH_FROM && <Input aria-label="Search columns" placeholder="Search columns" value={q} onChange={(e) => setQ(e.target.value)} />}
      <ul aria-label="Columns" className="grid gap-1">
        {columns.map((f) => (
          <li key={f.name} className="grid gap-1 rounded-md px-2 py-1.5 hover:bg-tray">
            <span className="flex items-baseline gap-2"><span className="font-mono text-body-sm text-fg">{f.name}</span> <span className="text-caption text-fg-3">{f.type}</span></span>
            {examples[f.name] && <span className="truncate text-caption text-fg-3">{examples[f.name]}</span>}
            <Checkbox checked={!!attrOf(f.name)} label="Keep as extra attribute" onToggle={() => edit(toggleAttr(spec, f.name, !attrOf(f.name)))} />
          </li>
        ))}
      </ul>
      {!columns.length && <p className="text-body-sm text-fg-3">No column is named like that. Clear the search to see every column.</p>}
    </div>
  );

  const inspector = row && isCore(selected) ? (
    <div className="grid gap-4 p-4">
      <h3 className="text-title-sm text-fg">{row.name}</h3>
      <Field id="mapper-source" label={`${row.name} comes from`}>
        <Select id="mapper-source" aria-label={`${row.name} comes from`} value={sourceValue(spec, selected)} onChange={(e) => {
          const v = e.target.value;
          if (!v) return remove(selected);
          if (v.startsWith("field:")) edit(setSource(spec, selected, { field: v.slice(6) }));
          else if (v === "preset:file_date" || v === "preset:arrived_date") edit(setSource(spec, selected, { preset: v.slice(7) as "file_date" | "arrived_date" }));
          else if (v === "const") edit(setSource(spec, selected, { currency: spec.currency ?? "IDR" }));
        }}>
          <option value="">Not mapped</option>
          {spec.fields.map((f) => <option key={f.name} value={`field:${f.name}`}>Column {f.name}</option>)}
          {Object.keys(spec.derive ?? {}).map((n) => <option key={n} value={`field:${n}`}>Computed {n}</option>)}
          {selected === "business_date" && <><option value="preset:file_date">File name&apos;s date</option><option value="preset:arrived_date">Day it arrives</option></>}
          {selected === "currency" && <option value="const">One currency for every row</option>}
          {sourceValue(spec, selected) === "cel" && <option value="cel">Formula</option>}
        </Select>
      </Field>
      {selected === "currency" && spec.currency && !spec.mapping.currency && (
        <Field id="mapper-currency" label="Currency for every row">
          <Input id="mapper-currency" maxLength={3} value={spec.currency} onChange={(e) => edit(setSource(spec, "currency", { currency: e.target.value.toUpperCase() }))} />
        </Field>
      )}
      {row.note && <p className="text-body-sm text-fg-2">{row.note}</p>}
      <Button type="button" variant="remove" size="icon" aria-label={`Remove the mapping of ${row.name}`} title="Remove mapping" onClick={() => remove(selected)}><Icon icon={RemoveIcon} /></Button>
      {refused && <p role="alert" className="text-body-sm text-down-ink">{refused}</p>}
    </div>
  ) : (
    <p className="p-4 text-body-sm text-fg-3">Select a core field to set where its value comes from, or drag a column onto it.</p>
  );

  const dock = (
    <p role="status" className="px-4 py-2 text-body-sm text-fg-2">
      {live.pending ? "Previewing…" : live.error ? `The preview stopped: ${live.error}` : live.result ? `${live.result.ok} of ${live.result.lines} rows read · ${live.result.quarantined} quarantined` : "The preview shows here once the sample is read."}
    </p>
  );

  return (
    <FullScreenEditor open={open} title={name.trim() || "New source"} description={summaryLine(spec)}
      onOpenChange={(o) => { if (!o) onCancel(); }}
      actions={<>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" onClick={() => onDone(spec)}>Done</Button>
      </>}
      rail={rail} inspector={inspector} dock={dock}>
      <FieldMapCanvas graph={graph} title="Core record" caption="What every row becomes" selected={selected} examples={null}
        label="Source map: the file's columns on the left, the core record on the right"
        onSelect={(p) => { setRefused(null); setSelected(p); }}
        onConnect={(col, target) => { if (isCore(target)) edit(connect(spec, col, target)); }}
        onRemove={remove} />
    </FullScreenEditor>
  );
}
