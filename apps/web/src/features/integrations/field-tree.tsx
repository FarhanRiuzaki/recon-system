"use client";

import { useState } from "react";
import { Checkbox, InfoTip } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { CloseIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import { toast } from "@starterkit/ui/ui/toast";
import { type AutoValue, FIELD_TYPES, type FieldType, fieldPaths, ISO_FORMAT, type OpField, readSpecPaste, suggestAuto } from "@starterkit/shared/integrations";

// An operation's request or response fields as a tree (DEC-053): name, type, required, length; a field can be masked
// (shown and stored hidden) and, on the request, given a fixed value. Fields come from a sample JSON or an OpenAPI file,
// then are edited here. Field names are the bank's terms (spec §2), so they show as they are.

const TYPE_LABEL: Record<FieldType, string> = { string: "Text", numeric: "Number", boolean: "Yes or no", object: "Group", array: "List" };
const has = (t: FieldType) => t === "object" || t === "array";

/** A request field's value: typed or mapped (none here), fixed, or filled by the system on every call. */
export type Values = {
  presets: Readonly<Record<string, string>>; auto: Readonly<Record<string, AutoValue>>;
  onChange: (path: string, v: { kind: "typed" } | { kind: "fixed"; value: string } | AutoValue) => void;
};
function ValueCell({ path, values, disabled, label }: { path: string; values: Values; disabled: boolean; label: string }) {
  const a = values.auto[path];
  const kind = a ? a.kind : path in values.presets ? "fixed" : "typed";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Select aria-label={`${label}: ${path} value`} value={kind} disabled={disabled} className="h-8 w-40 shrink-0"
        onChange={(e) => {
          const k = e.target.value;
          values.onChange(path, k === "fixed" ? { kind: "fixed", value: values.presets[path] ?? "" } : k === "external_id" ? { kind: "external_id" } : k === "now" ? { kind: "now", format: ISO_FORMAT } : { kind: "typed" });
        }}>
        <option value="typed">Typed or mapped</option>
        <option value="fixed">Fixed value</option>
        <option value="external_id">Auto: message ID</option>
        <option value="now">Auto: date and time</option>
      </Select>
      {kind === "fixed" && (
        <Input aria-label={`${label}: ${path} fixed value`} value={values.presets[path] ?? ""} maxLength={500} disabled={disabled} className="h-8 min-w-0 flex-1"
          onChange={(e) => values.onChange(path, { kind: "fixed", value: e.target.value })} />
      )}
      {a?.kind === "now" && (
        <Input aria-label={`${label}: ${path} date format`} value={a.format} maxLength={60} disabled={disabled} className="h-8 min-w-0 flex-1 font-mono"
          onChange={(e) => values.onChange(path, { kind: "now", format: e.target.value })} />
      )}
      {a?.kind === "external_id" && <span className="truncate text-caption text-fg-3">Auto generated</span>}
    </span>
  );
}

function Rows({ fields, prefix, depth, onChange, masked, onMask, values, disabled, label }: {
  fields: OpField[]; prefix: string; depth: number; onChange: (f: OpField[], rename?: [string, string]) => void; masked: readonly string[]; onMask: (path: string, on: boolean) => void;
  values?: Values; disabled: boolean; label: string;
}) {
  // a renamed field carries its fixed value, mask, success rule and reference (renamePath, by the operation editor)
  const set = (i: number, f: OpField, rename?: [string, string]) => {
    const was = fields[i]!;
    onChange(fields.map((x, j) => (j === i ? f : x)), rename ?? (was.name !== f.name ? [`${prefix}${was.name}`, `${prefix}${f.name}`] : undefined));
  };
  return (
    <ul className="grid gap-1.5">
      {fields.map((f, i) => {
        const path = `${prefix}${f.name}`;
        return (
          <li key={i} className="grid gap-1.5 motion-safe:animate-enter">
            <div className="grid grid-cols-[minmax(0,1.2fr)_8rem_5.5rem_4.5rem_3.5rem_minmax(0,1.4fr)_2rem] items-center gap-2 max-lg:grid-cols-2">
              {/* the indent sits inside the Field column, so every column stays under its header */}
              <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 1.25}rem` }}>
                <Input aria-label={`${label}: field ${path || i + 1} name`} value={f.name} maxLength={80} disabled={disabled} className="h-8 min-w-0 flex-1 font-mono" onChange={(e) => set(i, { ...f, name: e.target.value })} />
                {f.description && <InfoTip label={`What the spec says of ${path}`} title={path}>{f.description}</InfoTip>}
              </span>
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
              {values && !has(f.type) ? <ValueCell path={path} values={values} disabled={disabled} label={label} /> : <span />}
              {!disabled ? <Button type="button" variant="remove" size="icon" aria-label={`Remove ${path || "field"}`} onClick={() => onChange(fields.filter((_, j) => j !== i))}><Icon icon={CloseIcon} /></Button> : <span />}
            </div>
            {has(f.type) && (
              <Rows fields={f.children ?? []} prefix={`${path}.`} depth={depth + 1} masked={masked} onMask={onMask} values={values} disabled={disabled} label={label}
                onChange={(children, rename) => set(i, { ...f, children }, rename)} />
            )}
            {has(f.type) && !disabled && (
              <Button type="button" variant="add" size="sm" className="justify-self-start px-0" style={{ marginLeft: `${(depth + 1) * 1.25}rem` }}
                onClick={() => set(i, { ...f, children: [...(f.children ?? []), { name: "", type: "string", required: false }] })}>Add a field to {f.name || "this group"}</Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A field tree with Paste from the spec: a field table copied from the bank's spec (rows of name, M/O, type, length),
 * a sample JSON (types read from its values) or an OpenAPI file (its `path` and `method`); the fields read replace the tree.
 */
export function FieldTree({ title, fields, onChange, masked, onMask, values, onSuggest, disabled, openApi }: {
  title: string; fields: OpField[]; onChange: (f: OpField[], rename?: [string, string]) => void; masked: readonly string[]; onMask: (path: string, on: boolean) => void;
  values?: Values; disabled: boolean;
  /** Suggested auto values for the fields just read (request only). */
  onSuggest?: (fields: OpField[], auto: Record<string, AutoValue>) => void;
  /** The operation's path and method and which side this tree is, for an OpenAPI file. */
  openApi: { path: string; method: string; side: "request" | "response" };
}) {
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  function read() {
    const got = readSpecPaste(text, openApi.path, openApi.method, openApi.side);
    if (typeof got === "string") { setProblem(got); return; }
    // one change: the fields read and (request) the auto values they suggest, so neither undoes the other
    if (onSuggest) onSuggest(got.fields, suggestAuto(got.fields)); else onChange(got.fields);
    setImporting(false); setText(""); setProblem(null);
    const n = fieldPaths(got.fields).length;
    toast(`${n} ${n === 1 ? "field" : "fields"} read from the ${got.from === "table" ? "field table" : got.from === "sample" ? "sample" : "OpenAPI file"}.`);
  }
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label text-fg">{title}</h3>
        {!disabled && <Button type="button" variant="ghost" size="sm" onClick={() => setImporting(!importing)}>{importing ? "Close" : "Paste from the spec"}</Button>}
      </div>
      {importing && (
        <div className="grid gap-2 rounded-lg border border-line bg-tray p-3 motion-safe:animate-enter">
          <Textarea aria-label={`${title}: pasted from the spec`} rows={8} value={text} onChange={(e) => { setText(e.target.value); setProblem(null); }} className="font-mono"
            placeholder={"Copy the field table from the bank's spec (PDF or Word) and paste it here, or a sample JSON, or an OpenAPI file.\nfromDateTime   M   String   25   Range start"} />
          {problem && <span role="alert" className="text-caption text-down-ink">{problem}</span>}
          <span className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={read} disabled={!text.trim()}>Read fields</Button>
            <span className="text-caption text-fg-3">The fields read replace the ones below.</span>
          </span>
        </div>
      )}
      {fields.length > 0 && (
        <div aria-hidden="true" className="grid grid-cols-[minmax(0,1.2fr)_8rem_5.5rem_4.5rem_3.5rem_minmax(0,1.4fr)_2rem] gap-2 text-caption text-fg-3 max-lg:hidden">
          <span>Field</span><span>Type</span><span>Length</span><span>Required</span><span>Mask</span><span>{values ? "Value" : ""}</span><span />
        </div>
      )}
      {fields.length
        ? <Rows fields={fields} prefix="" depth={0} onChange={onChange} masked={masked} onMask={onMask} values={values} disabled={disabled} label={title} />
        : <p className="text-body-sm text-fg-3">No fields yet. Paste them from the spec or add one.</p>}
      {!disabled && (
        <Button type="button" variant="add" size="sm" className="justify-self-start px-0" onClick={() => onChange([...fields, { name: "", type: "string", required: false }])}>Add a field</Button>
      )}
    </section>
  );
}
