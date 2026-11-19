"use client";

import { type ChangeEvent, useRef } from "react";
import { Checkbox, Field, Notice, Panel, Switch } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { RemoveIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { FieldSpec, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { type DbEngine, FIELD_TYPES } from "@starterkit/shared/sources";
import { FILE_DATE, fieldTypeOf, TYPE_LABEL } from "../spec-draft";
import { ctl, type Draft, type Preview } from "./model";

type Core = Exclude<keyof SourceSpec["mapping"], "attrs">;
const CORE: { key: Core; label: string; note: string }[] = [
  { key: "business_date", label: "Business date", note: "The day each row counts for. Required." },
  { key: "amount_minor", label: "Amount", note: "An integer, or a decimal at 2 places: stored as whole minor units, so 100.5 and 100.50 are both 10050." },
  { key: "currency", label: "Currency", note: "ISO code, such as IDR." },
  { key: "direction", label: "Direction", note: "Debit or credit, as the source writes it." },
  { key: "event_time", label: "Event time", note: "When it happened, if the source says." },
  { key: "ext_ref", label: "Reference", note: "The source's own reference for the row." },
  { key: "account_ref", label: "Account", note: "The account or holder the row belongs to." },
];
const refValue = (r: ValueRef | undefined) => (!r ? "" : "field" in r ? (r.field ? `f:${r.field}` : "") : r.cel === FILE_DATE.cel ? "c:file_date" : `x:${r.cel}`);
const refOf = (v: string): ValueRef | undefined => (!v ? undefined : v.startsWith("f:") ? { field: v.slice(2) } : v === "c:file_date" ? FILE_DATE : { cel: v.slice(2) });

export type FieldsStepProps = {
  d: Draft;
  set: (fn: (d: Draft) => Draft) => void;
  err: (id: string) => string | undefined;
  /** The database engine (its float hint), null for a file source. */
  engine: DbEngine | null;
  /** Native types of the columns read from the source database, by name. */
  native: Map<string, string>;
  /** A source admin may read the columns again (a maker works from the version's fields). */
  canRead: boolean;
  reading: boolean;
  onReadColumns: () => void;
  sample: string;
  fileName: string;
  sampleCut: boolean;
  onSample: (text: string, fileName?: string) => void;
  onFileName: (name: string) => void;
  onReadSample: () => void;
  businessDate: string;
  onBusinessDate: (d: string) => void;
  preview: Preview;
};

/**
 * Step 2, Fields & mapping (Figma 23:6254, 25:6736, phone 29:7871): the columns as detected (a sample of the file, or
 * the source table), each typed by the user from that guess; the core record's values; derived values; and the
 * preview of what a sample becomes, updated as things change. Nothing here is saved until Next.
 */
export function FieldsStep(p: FieldsStepProps) {
  const { d, set, err } = p;
  const s = d.spec;
  const file = s.input.kind === "file_inbox";
  const setSpec = (fn: (s: SourceSpec) => SourceSpec) => set((x) => ({ ...x, spec: fn(x.spec) }));
  const setField = (i: number, patch: Partial<FieldSpec>) => setSpec((x) => ({ ...x, fields: x.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const setFormat = (i: number, patch: NonNullable<FieldSpec["format"]>) => setSpec((x) => ({
    ...x, fields: x.fields.map((f, j) => (j === i ? { ...f, format: Object.fromEntries(Object.entries({ ...f.format, ...patch }).filter(([, v]) => v !== undefined && v !== "")) } : f)),
  }));
  const setCore = (k: Core, r: ValueRef | undefined) => setSpec((x) => ({ ...x, mapping: { ...x.mapping, [k]: k === "business_date" ? (r ?? { field: "" }) : r } }));
  const names = [...s.fields.map((f) => f.name), ...Object.keys(s.derive)];
  const examples = new Map((p.preview.result?.columns ?? []).map((c) => [c.name, c.examples]));

  return (
    <div className="grid gap-section">
      {file ? (
        <Panel title="Sample of the file" description="Read in the browser and sent only to preview; nothing is stored" bodyClassName="grid gap-4">
          <SampleInput {...p} />
        </Panel>
      ) : (
        <Panel title="Columns of the source" description={s.input.kind === "db_watermark" && s.input.table ? `From ${s.input.table}` : "From the query"} bodyClassName="grid gap-3">
          {p.canRead
            ? <span><Button id="src-columns" type="button" variant="secondary" onClick={p.onReadColumns} disabled={p.reading} aria-busy={p.reading || undefined}>
              {p.reading && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Read the columns again</Button></span>
            : <p id="src-columns" tabIndex={-1} className="text-body-sm text-fg-2">These are the fields of the version this draft started from. A source admin reads the columns the table has now.</p>}
          {err("src-columns") && <p role="alert" className="text-body-sm text-down-ink">{err("src-columns")}</p>}
        </Panel>
      )}

      <Panel title="Core fields" description="What every recon needs from this source" bodyClassName="grid gap-4 md:grid-cols-2">
        {CORE.map((c) => {
          const id = ctl(`mapping.${c.key}`);
          const value = refValue(s.mapping[c.key]);
          const extra = value.startsWith("x:") ? [value] : [];
          return (
            <Field key={c.key} id={id} label={c.label} required={c.key === "business_date"} note={c.note} error={err(id)}>
              <Select className="w-full min-w-0" id={id} value={value} onChange={(e) => setCore(c.key, refOf(e.target.value))}>
                <option value="">{c.key === "business_date" ? "Pick a field" : c.key === "amount_minor" ? "This source has no amount" : "Not used"}</option>
                {c.key === "business_date" && file && <option value="c:file_date">From the file name</option>}
                {names.map((n) => <option key={n} value={`f:${n}`}>{n}</option>)}
                {extra.map((x) => <option key={x} value={x}>Expression: {x.slice(2)}</option>)}
              </Select>
            </Field>
          );
        })}
        {s.input.kind !== "db_snapshot" && (
          <span className="inline-flex items-center gap-2 md:col-span-2">
            <Switch id={ctl("mutable")} checked={s.mutable} onChange={(e) => setSpec((x) => ({ ...x, mutable: e.target.checked }))} aria-label="Rows can change after they arrive" />
            <label htmlFor={ctl("mutable")} className="text-body text-fg">Rows can change after they arrive (the newest per match key counts)</label>
          </span>
        )}
        {!s.mapping.amount_minor && <p className="text-caption text-fg-3 md:col-span-2">Recons on a source without an amount match by keys only.</p>}
      </Panel>

      <Panel flush title="Columns" description={`${s.fields.length} columns · type, format, empty allowed, match key and where each is stored`}>
        {err(ctl("key_fields")) && <p role="alert" className="px-4 pt-3 text-body-sm text-down-ink">{err(ctl("key_fields"))}</p>}
        {s.fields.length === 0 ? (
          <p className="px-4 py-6 text-body-sm text-fg-3">{file ? "Columns appear here once a sample is read." : "Columns appear here once the source's columns are read."}</p>
        ) : (
          <div className="scroll-quiet overflow-x-auto">
            <Table aria-label="Columns">
              <TableHeader><TableRow>
                <TableHead>Column</TableHead><TableHead>Example</TableHead><TableHead>Type</TableHead><TableHead>Format</TableHead>
                <TableHead>Empty ok</TableHead><TableHead>Match key</TableHead><TableHead>Stored as</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {s.fields.map((f, i) => {
                  const id = ctl(`fields.${i}`);
                  const hint = p.engine ? fieldTypeOf(p.engine, p.native.get(f.name) ?? "").note : undefined;
                  const why = err(id) ?? err(ctl(`fields.${i}.format`)) ?? err(ctl(`fields.${i}.name`));
                  const key = s.key_fields.includes(f.name);
                  const stored = Object.hasOwn(s.mapping.attrs, f.name);
                  return (
                    <TableRow key={f.name}>
                      <TableCell className="font-mono text-mono text-fg">{f.name}</TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-mono text-fg-3">{examples.get(f.name)?.[0] ?? "—"}</TableCell>
                      <TableCell>
                        <span className="grid gap-1">
                          <Select id={id} aria-label={`Type of ${f.name}`} value={f.type} aria-invalid={!!why || undefined} aria-describedby={why ? `${id}-why` : hint ? `${id}-hint` : undefined}
                            onChange={(e) => setField(i, { type: e.target.value as FieldSpec["type"], format: e.target.value === "decimal" ? { scale: 2 } : undefined })}>
                            {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                          </Select>
                          {why && <span id={`${id}-why`} role="alert" className="max-w-64 whitespace-normal text-caption text-down-ink">{why}</span>}
                          {!why && hint && <span id={`${id}-hint`} className="max-w-64 whitespace-normal text-caption text-fg-3">{hint}</span>}
                        </span>
                      </TableCell>
                      <TableCell><FormatCell f={f} i={i} setFormat={setFormat} err={err} /></TableCell>
                      <TableCell><Checkbox label={`${f.name} may be empty`} checked={f.nullable} onToggle={() => setField(i, { nullable: !f.nullable })} /></TableCell>
                      <TableCell><Checkbox label={`${f.name} is part of the match key`} checked={key}
                        onToggle={() => setSpec((x) => ({ ...x, key_fields: key ? x.key_fields.filter((k) => k !== f.name) : [...x.key_fields, f.name] }))} /></TableCell>
                      <TableCell>
                        <Select aria-label={`Where ${f.name} is stored`} value={stored ? "attrs" : ""} onChange={(e) => setSpec((x) => {
                          const { [f.name]: _drop, ...rest } = x.mapping.attrs;
                          return { ...x, mapping: { ...x.mapping, attrs: e.target.value ? { ...rest, [f.name]: { field: f.name } } : rest } };
                        })}>
                          <option value="attrs">attrs.{f.name}</option>
                          <option value="">Not stored</option>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Derived {...p} setSpec={setSpec} />
      <PreviewPanel {...p} />
    </div>
  );
}

/** The format a type is read with: a date's pattern, a datetime's pattern and zone, a decimal's places and separators. */
function FormatCell({ f, i, setFormat, err }: { f: FieldSpec; i: number; setFormat: (i: number, p: NonNullable<FieldSpec["format"]>) => void; err: (id: string) => string | undefined }) {
  const at = (k: string) => ctl(`fields.${i}.format.${k}`);
  if (f.type === "date" || f.type === "datetime") {
    return (
      <span className="grid min-w-40 gap-1">
        <Input id={at("date")} aria-label={`Date format of ${f.name}`} placeholder={f.type === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss"} className="font-mono" value={f.format?.date ?? ""}
          onChange={(e) => setFormat(i, { date: e.target.value || undefined })} />
        {f.type === "datetime" && (
          <Input id={at("timezone")} aria-label={`Time zone of ${f.name}`} placeholder="Asia/Jakarta" value={f.format?.timezone ?? ""} aria-invalid={!!err(at("timezone")) || undefined}
            onChange={(e) => setFormat(i, { timezone: e.target.value || undefined })} />
        )}
        {err(at("timezone")) && <span role="alert" className="max-w-48 whitespace-normal text-caption text-down-ink">{err(at("timezone"))}</span>}
      </span>
    );
  }
  if (f.type === "decimal") {
    return (
      <span className="flex min-w-56 items-center gap-2">
        <Select id={at("scale")} aria-label={`Places of ${f.name}`} value={String(f.format?.scale ?? 2)} onChange={(e) => setFormat(i, { scale: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} places</option>)}
        </Select>
        <Select id={at("decimalSeparator")} aria-label={`Decimal separator of ${f.name}`} value={f.format?.decimalSeparator ?? "."}
          onChange={(e) => setFormat(i, { decimalSeparator: e.target.value as "." | "," })}>
          <option value=".">1,234.50</option><option value=",">1.234,50</option>
        </Select>
      </span>
    );
  }
  return <span className="text-fg-3">—</span>;
}

/** The sample: pasted or chosen from a file (its first 32 KB), and the file name its business date comes from. */
function SampleInput(p: FieldsStepProps) {
  const pick = useRef<HTMLInputElement>(null);
  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) p.onSample(await f.slice(0, 64 * 1024).text(), f.name);
    e.target.value = "";
  };
  return (
    <>
      <Field id="src-sample" label="Sample" note="Paste the first lines of a file, or choose one. Up to 32 KB is read." error={p.err("src-sample")}>
        <Textarea id="src-sample" value={p.sample} rows={6} className="font-mono" spellCheck={false} onChange={(e) => p.onSample(e.target.value)} />
      </Field>
      {p.sampleCut && <Notice>Only the first 32 KB of the file is previewed.</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="src-file-name" label="File name" note="Its date (yyyyMMdd) is the business date, as when the inbox picks the file up: act20261102.txt is 2 Nov 2026.">
          <Input id="src-file-name" value={p.fileName} className="font-mono" onChange={(e) => p.onFileName(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <span className="flex flex-wrap gap-3">
        <Button id="src-columns" type="button" onClick={p.onReadSample} disabled={!p.sample.trim()}>Read the sample</Button>
        <Button type="button" variant="secondary" onClick={() => pick.current?.click()}>Choose a file</Button>
        <input ref={pick} type="file" accept=".txt,.csv,.dat,text/plain,text/csv" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void choose(e)} />
      </span>
    </>
  );
}

/** Derived values: a name and a CEL expression over `row`, `file_name` and `file_date`; usable as a core value or key. */
function Derived({ d, err, setSpec }: FieldsStepProps & { setSpec: (fn: (s: SourceSpec) => SourceSpec) => void }) {
  const entries = Object.entries(d.spec.derive);
  const rename = (from: string, to: string) => setSpec((x) => ({ ...x, derive: Object.fromEntries(Object.entries(x.derive).map(([k, v]) => [k === from ? to : k, v])) }));
  return (
    <Panel title="Derived values" description="Optional · computed per row before mapping, with CEL: row.col_13, file_name, file_date" bodyClassName="grid gap-3">
      {entries.map(([name, expr], i) => {
        const id = ctl(`derive.${name}`);
        return (
          <div key={i} className="grid items-start gap-3 md:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <Input aria-label={`Name of derived value ${i + 1}`} value={name} className="font-mono" onChange={(e) => rename(name, e.target.value)} />
            <Field id={id} label={`Expression for ${name || "this value"}`} error={err(id)}>
              <Input id={id} value={expr} className="font-mono" spellCheck={false} onChange={(e) => setSpec((x) => ({ ...x, derive: { ...x.derive, [name]: e.target.value } }))} />
            </Field>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name || "this derived value"}`}
              onClick={() => setSpec((x) => { const { [name]: _drop, ...rest } = x.derive; return { ...x, derive: rest }; })}><Icon icon={RemoveIcon} /></Button>
          </div>
        );
      })}
      <span><Button type="button" variant="secondary" onClick={() => setSpec((x) => ({ ...x, derive: { ...x.derive, [`value_${Object.keys(x.derive).length + 1}`]: "" } }))}>Add a derived value</Button></span>
    </Panel>
  );
}

/** What the sample becomes under the spec on screen: records for the core table and the lines that would be quarantined. */
function PreviewPanel(p: FieldsStepProps) {
  const r = p.preview.result;
  const file = p.d.spec.input.kind === "file_inbox";
  return (
    <Panel flush title="Preview" description={file ? `${p.fileName || "the sample"} · updates as you change columns · not stored` : "Pulled from the source · updates as you change columns · not stored"}>
      <div className="grid gap-3 p-4">
        {p.d.spec.input.kind === "db_snapshot" && (
          <div className="max-w-xs">
            <Field id="src-preview-date" label="Business date" note="The date the query runs for in the preview.">
              <Input id="src-preview-date" type="date" value={p.businessDate} onChange={(e) => p.onBusinessDate(e.target.value)} />
            </Field>
          </div>
        )}
        <PreviewResult preview={p.preview} />
        {!r && !p.preview.error && !p.preview.pending && <p className="text-body-sm text-fg-3">The preview appears once the columns are read and the business date is mapped.</p>}
      </div>
    </Panel>
  );
}

/** The preview's counts, its first records and its quarantined lines with a reason per column. Shared with the version page. */
export function PreviewResult({ preview }: { preview: Preview }) {
  const r = preview.result;
  return (
    <div aria-busy={preview.pending || undefined} className="grid gap-3">
      {preview.pending && <p role="status" className="flex items-center gap-2 text-body-sm text-fg-2"><Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />Updating the preview</p>}
      {preview.error && <Notice tone="warn" live>{preview.error}</Notice>}
      {r && (
        <>
          <p role="status" className="text-body-sm text-fg">
            {formatNumber(r.lines)} rows read: {formatNumber(r.ok)} become records, {formatNumber(r.quarantined)} go to quarantine. Quarantined rows don&apos;t stop the file.
          </p>
          {r.records.length > 0 && (
            <div className="scroll-quiet overflow-x-auto">
              <Table aria-label="Preview records">
                <TableHeader><TableRow>
                  <TableHead>Row</TableHead><TableHead>business_date</TableHead><TableHead>amount_minor</TableHead><TableHead>Match key</TableHead><TableHead>account_ref</TableHead><TableHead>attrs</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {r.records.slice(0, 10).map((x) => (
                    <TableRow key={x.line}>
                      <TableCell className="tabular">{x.line}</TableCell>
                      <TableCell className="font-mono text-mono">{x.businessDate}</TableCell>
                      <TableCell className="font-mono text-mono">{x.amountMinor ?? "—"}</TableCell>
                      <TableCell className="font-mono text-mono">{x.naturalKey?.replaceAll("\u001f", " · ") ?? "—"}</TableCell>
                      <TableCell className="font-mono text-mono">{x.accountRef ?? "—"}</TableCell>
                      <TableCell className="max-w-96 truncate font-mono text-mono text-fg-2">
                        {Object.entries(x.attrs).map(([k, v]) => `${k}=${v === null ? "∅" : String(v)}`).join(" · ") || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {r.quarantine.length > 0 && (
            <div className="grid gap-1">
              <h3 className="text-label text-fg">Quarantined</h3>
              <ul className="grid gap-1 text-body-sm text-fg">
                {r.quarantine.slice(0, 20).map((q) => (
                  <li key={q.line}>Row {q.line} · {Object.entries(q.reasons).map(([k, v]) => (k === "_row" ? v : v.startsWith(k) ? v : `${k}: ${v}`)).join("; ")}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
