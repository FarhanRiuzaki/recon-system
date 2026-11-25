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
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import { FieldMapCanvas } from "@/components/field-map/canvas";
import { computeSteps } from "@starterkit/shared/compute";
import { AMOUNT_UNITS, type AmountUnit, FIELD_TYPES } from "@starterkit/shared/sources";
import { TYPE_LABEL, UNIT_LABEL } from "../spec-draft";
import { addComputed, CORE_ROWS, type CoreRow, columnInfo, connect, setFormat, disconnect, removeAttr, renameAttr, rowProblem, setColumn, setJsonPath, setSource, setUnit, sourceGraph, summaryLine, toggleAttr } from "../mapper-model";
import { useSpecPreview } from "../use-spec-preview";
import { ComputedColumns } from "./computed";
import { FormatCell } from "./format-cell";
import { AddIcon } from "@starterkit/ui/ui/icons";

/** A JSON path the reader takes: keys joined by dots (code.rc). */
const JSON_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** Past this many columns the rail offers a search. */
const SEARCH_FROM = 30;
const isCore = (k: string | null): k is CoreRow => !!k && (CORE_ROWS as readonly string[]).includes(k);

type PreviewOf = { spaceId: string; ids: { sourceId: string; versionId: string } | null; file: boolean; sampleId: string | null; sample: string; fileName: string; businessDate: string };

/** What feeds core row `k` as the inspector's select value. */
function sourceValue(spec: SourceSpec, k: CoreRow): string {
  const r = (spec.mapping as unknown as Record<string, { field: string } | { cel: string } | undefined>)[k];
  if (k === "currency" && !r && spec.currency) return "const";
  if (!r) return "";
  if ("field" in r) return r.field ? `field:${r.field}` : "";
  if (r.cel === "file_date" || r.cel === "arrived_date") return `preset:${r.cel}`;
  return jsonOf(r.cel) ? "json" : "cel";
}

/** A formula that reads one JSON path of a column, as its column and path. */
function jsonOf(cel: string): { col: string; path: string } | null {
  const b = computeSteps(cel);
  return b?.steps.length === 1 && b.steps[0]!.type === "json" ? { col: b.source, path: String(b.steps[0]!.args[0] ?? "") } : null;
}

/** A formula or JSON path being typed in the inspector (applied once it has text). */
type Typing = { row: CoreRow; kind: "cel"; cel: string } | { row: CoreRow; kind: "json"; col: string; path: string };

export function SourceMapper({ open, name, spec: given, examples, preview, initial = null, onDone, onCancel }: {
  open: boolean; name: string; spec: SourceSpec; examples: Readonly<Record<string, string>>; preview: PreviewOf;
  /** Where it opens: a core field, `col:<column>` or `attrs` (a step 2 problem's place). */
  initial?: string | null;
  onDone: (spec: SourceSpec) => void; onCancel: () => void;
}) {
  const [spec, setSpec] = useState(given);
  const [selected, setSelected] = useState<string | null>(initial);
  const [q, setQ] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  // Escape, the close button or a click outside ask when something changed (the posting editor's rule)
  const [held, setHeld] = useState(false);
  const dirty = JSON.stringify(spec) !== JSON.stringify(given);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [storedTyped, setStoredTyped] = useState<{ col: string; name: string; why: string } | null>(null);
  const graph = useMemo(() => sourceGraph(spec, examples, { q }), [spec, examples, q]);
  const live = useSpecPreview({ ...preview, spec, enabled: open });
  /** `typed`: the edit comes from the formula or JSON path being typed, which stays on screen. */
  const edit = (next: SourceSpec, typed = false) => { setRefused(null); if (!typed) setTyping(null); setSpec(next); };
  const choose = (p: string | null) => { setRefused(null); setTyping(null); setStoredTyped(null); setSelected(p); };
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
            <span className="flex items-baseline gap-2">
              <button type="button" aria-label={`Edit column ${f.name}`} className="font-mono text-body-sm text-fg underline-offset-2 hover:underline" onClick={() => choose(`col:${f.name}`)}>{f.name}</button>{" "}
              <span className="text-caption text-fg-3">{f.type}{attrOf(f.name) ? " · extra attribute" : ""}</span>
            </span>
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
        <Select id="mapper-source" aria-label={`${row.name} comes from`} value={typing?.row === selected ? typing.kind : sourceValue(spec, selected)} onChange={(e) => {
          const v = e.target.value;
          setTyping(null);
          if (v === "cel") { const r = (spec.mapping as unknown as Record<string, { cel?: string } | undefined>)[selected]; return setTyping({ row: selected, kind: "cel", cel: r?.cel ?? "" }); }
          if (v === "json") { const r = (spec.mapping as unknown as Record<string, { field?: string } | undefined>)[selected]; return setTyping({ row: selected, kind: "json", col: r?.field || (spec.fields[0]?.name ?? ""), path: "" }); }
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
          <option value="json">JSON path in a column</option>
          <option value="cel">Formula</option>
        </Select>
      </Field>
      {(() => {
        const cur = (spec.mapping as unknown as Record<string, { cel?: string } | undefined>)[selected]?.cel;
        const t = typing?.row === selected ? typing : sourceValue(spec, selected) === "json" && cur ? { row: selected, kind: "json" as const, ...jsonOf(cur)! } : sourceValue(spec, selected) === "cel" && cur ? { row: selected, kind: "cel" as const, cel: cur } : null;
        if (!t) return null;
        if (t.kind === "cel") return (
          <Field id="mapper-cel" label="Formula" note="Columns by name, as in Computed columns">
            {/* applied when the box is left, so a half-typed formula never reaches the spec; empty removes the mapping */}
            <Input id="mapper-cel" aria-label="Formula" className="font-mono" value={t.cel} onChange={(e) => setTyping({ row: selected, kind: "cel", cel: e.target.value })}
              onBlur={(e) => {
                const cel = e.target.value.trim();
                if (cel) edit(setSource(spec, selected, { cel }), true);
                else { const r = disconnect(spec, selected); if ("refused" in r) setRefused(r.refused); else edit(r, true); }
              }} />
          </Field>
        );
        const pathOk = JSON_PATH.test(t.path.trim());
        const apply = (col: string, path: string) => { setTyping({ row: selected, kind: "json", col, path }); if (col && JSON_PATH.test(path.trim())) edit(setJsonPath(spec, selected, col, path.trim()), true); };
        return (<>
          <Field id="mapper-json-col" label="JSON column">
            <Select id="mapper-json-col" aria-label="JSON column" value={t.col} onChange={(e) => apply(e.target.value, t.path)}>
              {spec.fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </Select>
          </Field>
          <Field id="mapper-json-path" label="JSON path" note="Keys with dots, like code.rc" error={t.path.trim() && !pathOk ? "Use keys joined by dots, like code.rc." : undefined}>
            <Input id="mapper-json-path" aria-label="JSON path" className="font-mono" value={t.path} onChange={(e) => apply(t.col, e.target.value)} />
          </Field>
        </>);
      })()}
      {selected === "amount_minor" && spec.mapping.amount_minor && (
        <Field id="mapper-unit" label="Amount unit">
          <Select id="mapper-unit" aria-label="Amount unit" value={spec.mapping.amount_minor.unit ?? ""} onChange={(e) => { if (e.target.value) edit(setUnit(spec, e.target.value as AmountUnit)); }}>
            <option value="" disabled>Choose a unit</option>
            {AMOUNT_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
          </Select>
        </Field>
      )}
      {selected === "currency" && spec.currency && !spec.mapping.currency && (
        <Field id="mapper-currency" label="Currency for every row">
          <Select id="mapper-currency" value={spec.currency} onChange={(e) => edit(setSource(spec, "currency", { currency: e.target.value }))}>
            {Object.keys(CURRENCY_EXPONENT).map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      )}
      {row.note && <p className="text-body-sm text-fg-2">{row.note}</p>}
      <Button type="button" variant="remove" size="icon" aria-label={`Remove the mapping of ${row.name}`} title="Remove mapping" onClick={() => remove(selected)}><Icon icon={RemoveIcon} /></Button>
      {refused ? <p role="alert" className="text-body-sm text-down-ink">{refused}</p> : rowProblem(spec, selected) && <p className="text-body-sm text-down-ink">{rowProblem(spec, selected)}</p>}
    </div>
  ) : selected === "attrs" ? (
    <div className="grid gap-3 p-4">
      <h3 className="text-title-sm text-fg">Extra attributes</h3>
      {Object.keys(spec.mapping.attrs ?? {}).length ? (
        <ul aria-label="Extra attributes" className="grid gap-1">
          {Object.entries(spec.mapping.attrs ?? {}).map(([n, r]) => (
            <li key={n} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-body-sm"><span className="font-mono text-fg">{n}</span>{"field" in r && r.field !== n && <span className="text-fg-3"> from {r.field}</span>}</span>
              <Button type="button" variant="remove" size="icon-sm" aria-label={`Stop keeping ${"field" in r ? r.field : n}`} onClick={() => edit(removeAttr(spec, n))}><Icon icon={RemoveIcon} /></Button>
            </li>
          ))}
        </ul>
      ) : <p className="text-body-sm text-fg-3">No column is kept yet. Tick Keep as extra attribute on a column in the list.</p>}
    </div>
  ) : selected?.startsWith("col:") && columnInfo(spec, selected.slice(4)) ? (() => {
    const col = selected.slice(4);
    const info = columnInfo(spec, col)!;
    const typed = storedTyped?.col === col ? storedTyped : null;
    return (
      <div className="grid gap-4 p-4">
        <h3 className="font-mono text-title-sm text-fg">{col}</h3>
        <Field id="mapper-col-type" label={`Type of ${col}`}>
          <Select id="mapper-col-type" aria-label={`Type of ${col}`} value={info.type} onChange={(e) => edit(setColumn(spec, col, { type: e.target.value as typeof info.type }))}>
            {FIELD_TYPES.map((x) => <option key={x} value={x}>{TYPE_LABEL[x]}</option>)}
          </Select>
        </Field>
        <Checkbox checked={info.nullable} label="Can be empty" onToggle={() => edit(setColumn(spec, col, { nullable: !info.nullable }))} />
        <Checkbox checked={!!info.stored} label="Keep as extra attribute" onToggle={() => { setStoredTyped(null); edit(toggleAttr(spec, col, !info.stored)); }} />
        {info.stored && (
          <Field id="mapper-stored" label="Stored as" error={typed?.why}>
            <Input id="mapper-stored" aria-label="Stored as" className="font-mono" value={typed?.name ?? info.stored} onChange={(e) => {
              const r = renameAttr(spec, col, e.target.value);
              if ("refused" in r) setStoredTyped({ col, name: e.target.value, why: r.refused });
              else { setStoredTyped(null); edit(r); }
            }} />
          </Field>
        )}
        {(info.type === "date" || info.type === "datetime" || info.type === "decimal") && (
          <div className="grid gap-1">
            <span className="text-body-sm text-fg-2">Format</span>
            <FormatCell f={spec.fields.find((x) => x.name === col)!} i={spec.fields.findIndex((x) => x.name === col)} err={() => undefined}
              idOf={(k) => `mapper-format-${k}`} setFormat={(_, patch) => edit(setFormat(spec, col, patch))} />
          </div>
        )}
      </div>
    );
  })() : (
    <p className="p-4 text-body-sm text-fg-3">Select a core field to set where its value comes from, or drag a column onto it.</p>
  );

  const exampleMap = useMemo(() => new Map(Object.entries(examples).map(([k, v]) => [k, v ? [v] : []])), [examples]);
  const dock = (
    <div className="grid gap-3 px-4 py-2">
      <p role="status" className="text-body-sm text-fg-2">
        {live.pending ? "Previewing…" : live.error ? `The preview stopped: ${live.error}` : live.result ? `${live.result.ok} of ${live.result.lines} rows read · ${live.result.quarantined} quarantined` : "The preview shows here once the sample is read."}
      </p>
      {/* computed columns are made here too (the list's own editor), and join the canvas's Computed table to be drawn */}
      <div className="grid gap-3">
        {spec.fields.length > 0 && (
          <span><Button type="button" variant="create" size="sm" onClick={() => { const r = addComputed(spec); edit(r.spec); }}><Icon icon={AddIcon} />Add computed column</Button></span>
        )}
        <ComputedColumns spec={spec} setSpec={(fn) => { setRefused(null); setTyping(null); setSpec(fn); }} err={() => undefined} examples={exampleMap} renderUseAs={() => null} />
      </div>
    </div>
  );

  return (
    <FullScreenEditor open={open} title={name.trim() || "New source"} description={summaryLine(spec)}
      onOpenChange={(o) => { if (!o) { if (dirty) setHeld(true); else onCancel(); } }}
      actions={<>
        {held && <span role="status" className="text-body-sm text-degraded-ink">Use Cancel to drop your changes, or Done to keep them.</span>}
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" onClick={() => onDone(spec)}>Done</Button>
      </>}
      rail={rail} inspector={inspector} dock={dock}>
      <FieldMapCanvas graph={graph} title="Core record" caption="What every row becomes" selected={selected} examples={null}
        label="Source map: the file's columns on the left, the core record on the right"
        onSelect={choose}
        onConnect={(col, target) => { if (isCore(target)) edit(connect(spec, col, target)); }}
        onRemove={remove} />
    </FullScreenEditor>
  );
}
