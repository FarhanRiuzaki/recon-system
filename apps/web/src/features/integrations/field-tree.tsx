"use client";

import { useState } from "react";
import { Checkbox } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { FIELD_TYPES, type FieldType, fieldsFromOpenApi, fieldsFromSample, type OpField } from "@starterkit/shared/integrations";

// An operation's request or response fields as a tree (DEC-053): name, type, required, length; a field can be masked
// (shown and stored hidden) and, on the request, given a fixed value. Fields come from a sample JSON or an OpenAPI file,
// then are edited here. Field names are the bank's terms (spec §2), so they show as they are.

const TYPE_LABEL: Record<FieldType, string> = { string: "Text", numeric: "Number", boolean: "Yes or no", object: "Group", array: "List" };
const has = (t: FieldType) => t === "object" || t === "array";

function Rows({ fields, prefix, depth, onChange, masked, onMask, presets, onPreset, disabled, label }: {
  fields: OpField[]; prefix: string; depth: number; onChange: (f: OpField[]) => void; masked: readonly string[]; onMask: (path: string, on: boolean) => void;
  presets?: Readonly<Record<string, string>>; onPreset?: (path: string, v: string) => void; disabled: boolean; label: string;
}) {
  const set = (i: number, f: OpField) => onChange(fields.map((x, j) => (j === i ? f : x)));
  return (
    <ul className="grid gap-1.5">
      {fields.map((f, i) => {
        const path = `${prefix}${f.name}`;
        return (
          <li key={i} className="grid gap-1.5 motion-safe:animate-enter" style={{ paddingLeft: `${depth * 1.25}rem` }}>
            <div className="grid grid-cols-[minmax(0,1.3fr)_8rem_5.5rem_4.5rem_3.5rem_minmax(0,1fr)_2rem] items-center gap-2 max-lg:grid-cols-2">
              <Input aria-label={`${label}: field ${path || i + 1} name`} value={f.name} maxLength={80} disabled={disabled} className="h-8 font-mono" onChange={(e) => set(i, { ...f, name: e.target.value })} />
              <Select aria-label={`${label}: ${path} type`} value={f.type} disabled={disabled} className="h-8"
                onChange={(e) => { const type = e.target.value as FieldType; set(i, has(type) ? { ...f, type, children: f.children ?? [] } : { name: f.name, type, required: f.required, ...(f.maxLength ? { maxLength: f.maxLength } : {}) }); }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </Select>
              {has(f.type) ? <span /> : (
                <Input aria-label={`${label}: ${path} max length`} type="number" min={1} max={10000} placeholder="Length" value={f.maxLength ?? ""} disabled={disabled} className="h-8"
                  onChange={(e) => { const n = Number(e.target.value); const { maxLength: _, ...rest } = f; set(i, n > 0 ? { ...rest, maxLength: Math.min(10000, Math.round(n)) } : rest); }} />
              )}
              <Checkbox label={`${path || "Field"}: required`} checked={f.required} readOnly={disabled} onToggle={() => set(i, { ...f, required: !f.required })} />
              <Checkbox label={`${path || "Field"}: mask`} checked={masked.includes(path)} readOnly={disabled} onToggle={() => onMask(path, !masked.includes(path))} />
              {onPreset && !has(f.type)
                ? <Input aria-label={`${label}: ${path} fixed value`} placeholder="Fixed value (optional)" value={presets?.[path] ?? ""} maxLength={500} disabled={disabled} className="h-8" onChange={(e) => onPreset(path, e.target.value)} />
                : <span />}
              {!disabled ? <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${path || "field"}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}><Icon icon={CloseIcon} /></Button> : <span />}
            </div>
            {has(f.type) && (
              <Rows fields={f.children ?? []} prefix={`${path}.`} depth={depth + 1} masked={masked} onMask={onMask} presets={presets} onPreset={onPreset} disabled={disabled} label={label}
                onChange={(children) => set(i, { ...f, children })} />
            )}
            {has(f.type) && !disabled && (
              <Button type="button" variant="link" size="sm" className="justify-self-start px-0" style={{ marginLeft: "1.25rem" }}
                onClick={() => set(i, { ...f, children: [...(f.children ?? []), { name: "", type: "string", required: false }] })}>Add a field to {f.name || "this group"}</Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A field tree with Import: paste a sample JSON (types read from its values) or an OpenAPI file (its `path` and
 * `method`); imported fields replace the tree.
 */
export function FieldTree({ title, fields, onChange, masked, onMask, presets, onPreset, disabled, openApi }: {
  title: string; fields: OpField[]; onChange: (f: OpField[]) => void; masked: readonly string[]; onMask: (path: string, on: boolean) => void;
  presets?: Readonly<Record<string, string>>; onPreset?: (path: string, v: string) => void; disabled: boolean;
  /** The operation's path and method and which side this tree is, for an OpenAPI file. */
  openApi: { path: string; method: string; side: "request" | "response" };
}) {
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  function read(kind: "sample" | "openapi") {
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { setProblem("This isn't JSON. Paste the sample or the OpenAPI file as JSON."); return; }
    const got = kind === "sample" ? fieldsFromSample(doc) : fieldsFromOpenApi(doc, openApi.path, openApi.method);
    if (typeof got === "string") { setProblem(got); return; }
    const next = Array.isArray(got) ? got : got[openApi.side];
    if (!next.length) { setProblem("No fields were found in it."); return; }
    onChange(next); setImporting(false); setText(""); setProblem(null);
  }
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label text-fg">{title}</h3>
        {!disabled && <Button type="button" variant="ghost" size="sm" onClick={() => setImporting(!importing)}>{importing ? "Close import" : "Import fields"}</Button>}
      </div>
      {importing && (
        <div className="grid gap-2 rounded-lg border border-line bg-tray p-3 motion-safe:animate-enter">
          <Textarea aria-label={`${title}: sample JSON or OpenAPI file`} rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono"
            placeholder={'Paste a sample, e.g. { "ResponseCode": "00", "ReferenceNumber": "123456" }, or an OpenAPI file'} />
          {problem && <span role="alert" className="text-caption text-down-ink">{problem}</span>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => read("sample")}>Read a sample</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => read("openapi")}>Read an OpenAPI file</Button>
          </div>
        </div>
      )}
      {fields.length > 0 && (
        <div aria-hidden="true" className="grid grid-cols-[minmax(0,1.3fr)_8rem_5.5rem_4.5rem_3.5rem_minmax(0,1fr)_2rem] gap-2 text-caption text-fg-3 max-lg:hidden">
          <span>Field</span><span>Type</span><span>Length</span><span>Required</span><span>Mask</span><span>{onPreset ? "Fixed value" : ""}</span><span />
        </div>
      )}
      {fields.length
        ? <Rows fields={fields} prefix="" depth={0} onChange={onChange} masked={masked} onMask={onMask} presets={presets} onPreset={onPreset} disabled={disabled} label={title} />
        : <p className="text-body-sm text-fg-3">No fields yet. Import a sample or add one.</p>}
      {!disabled && (
        <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => onChange([...fields, { name: "", type: "string", required: false }])}>Add a field</Button>
      )}
    </section>
  );
}
