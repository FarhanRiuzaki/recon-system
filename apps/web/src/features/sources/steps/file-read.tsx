"use client";

// "How the file is read" (the file reader, DEC-058): what detection proposed for the sample, as a one-line summary and
// the sample's rows with the role each gets; Change opens the settings of the format's kind. A close call opens them
// with a notice; no rule at all says the file can't be read automatically yet; a type it can't read says which.
import { useRef, useState } from "react";
import { Field, Notice, Panel, Segmented, Switch } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { EditIcon, SpinnerIcon, UploadIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import type { DetectDto, FileFormat } from "@starterkit/shared/contracts/sources";
import { FILE_ENCODINGS } from "@starterkit/shared/sources";
import { ROLE_LABEL, summaryOf, toggleBoundary } from "./file-read-model";

type Props = {
  result: DetectDto | null; busy: boolean; error: string | null; format: FileFormat;
  /** A source admin: may change how the file is read (`sameReading`); everyone else sees the summary. */
  canChange: boolean;
  onChange: (f: FileFormat) => void;
  onPickFile: (f: File) => void;
};

const KINDS = [{ value: "delimited", label: "Delimited" }, { value: "fixed_width", label: "Fixed length" }, { value: "excel", label: "Excel" }] as const;
const DELIMITERS: [string, string][] = [[",", "Comma ,"], [";", "Semicolon ;"], ["|", "Pipe |"], ["\t", "Tab"]];
const PREVIEW_ROWS = 20;
const count = (v: string) => Math.max(0, Math.min(1000, Number(v.replace(/\D/g, "")) || 0));
const withSkip = <F extends FileFormat>(f: F, key: "skip_top" | "skip_bottom", n: number): F => {
  const next = { ...f } as F & Partial<Record<"skip_top" | "skip_bottom", number>>;
  if (n) next[key] = n; else delete next[key];
  return next;
};

/** A new format of `kind`, keeping what carries over (encoding, header, skips). */
function asKind(f: FileFormat, kind: FileFormat["kind"], firstLine: string): FileFormat {
  const skips = { ...(f.skip_top ? { skip_top: f.skip_top } : {}), ...(f.skip_bottom ? { skip_bottom: f.skip_bottom } : {}) };
  const encoding = f.kind === "excel" ? "utf-8" : f.encoding;
  if (kind === "delimited") return { kind, delimiter: ",", quote: '"', header: f.header, encoding, ...skips };
  if (kind === "fixed_width") return { kind, encoding, header: f.header, columns: [{ start: 1, length: Math.max(1, firstLine.length) }], ...skips };
  return { kind, sheet: { kind: "first" }, header: f.header, ...skips };
}

export function FileRead(p: Props) {
  const r = p.result;
  const supported = r?.supported ? r : null;
  const close = !!supported && supported.confidence !== "high";
  const [open, setOpen] = useState(false);
  const shown = p.canChange && (open || close);
  const picker = useRef<HTMLInputElement>(null);
  const firstLine = supported?.rows.find((x) => x.role === "detail")?.cells.join("") ?? "";
  return (
    <Panel title="How the file is read" bodyClassName="grid gap-4"
      actions={p.canChange ? <>
        <input ref={picker} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept=".csv,.txt,.dat,.tsv,.xlsx,.xls"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onPickFile(f); e.target.value = ""; }} />
        <Button type="button" variant="secondary" size="sm" disabled={p.busy} onClick={() => picker.current?.click()}><Icon icon={UploadIcon} />Use another sample</Button>
      </> : undefined}>
      {p.busy && <p role="status" className="flex items-center gap-2 text-body text-fg-2"><Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />Reading the file…</p>}
      {p.error && <Notice tone="warn" live>{p.error}</Notice>}
      {r && !r.supported && <Notice tone="warn" live>{r.reason}</Notice>}
      {supported && supported.confidence !== "high" && supported.notes.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
      {supported && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 text-body text-fg">{summaryOf(p.format, supported.fileName)}</p>
          {p.canChange && !close && (
            <Button type="button" variant="edit" size="sm" aria-label="Change how the file is read" aria-expanded={open} onClick={() => setOpen((x) => !x)}><Icon icon={EditIcon} />Change</Button>
          )}
        </div>
      )}
      {shown && <Settings format={p.format} onChange={p.onChange} firstLine={firstLine} />}
      {supported && supported.rows.length > 0 && (
        <div className="scroll-quiet max-h-96 overflow-auto rounded-md border border-line">
          <table className="w-full border-separate border-spacing-0 font-mono text-body-sm">
            <tbody>
              {supported.rows.slice(0, PREVIEW_ROWS).map((x, i) => (
                <tr key={`${x.line}-${i}`} className={x.role === "detail" ? "" : "text-fg-3"}>
                  <td className="border-b border-line px-2 py-1 text-right text-fg-3">{x.line || ""}</td>
                  <td data-role={x.role} className="border-b border-line px-2 py-1 font-sans whitespace-nowrap">{ROLE_LABEL[x.role]}</td>
                  {x.cells.map((c, k) => <td key={k} className="border-b border-line px-2 py-1 whitespace-pre">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The settings of the format's kind. */
function Settings({ format: f, onChange, firstLine }: { format: FileFormat; onChange: (f: FileFormat) => void; firstLine: string }) {
  return (
    <div className="grid gap-4 rounded-md border border-line p-3">
      <Segmented label="File kind" value={f.kind} options={KINDS} onChange={(k) => onChange(asKind(f, k, firstLine))} />
      <div className="grid gap-4 md:grid-cols-3">
        {f.kind === "delimited" && (
          <Field id="fr-delimiter" label="Delimiter">
            <Select id="fr-delimiter" value={f.delimiter} onChange={(e) => onChange({ ...f, delimiter: e.target.value })}>
              {DELIMITERS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </Select>
          </Field>
        )}
        {f.kind !== "excel" && (
          <Field id="fr-encoding" label="Encoding">
            <Select id="fr-encoding" value={f.encoding} onChange={(e) => onChange({ ...f, encoding: e.target.value as (typeof FILE_ENCODINGS)[number] })}>
              {FILE_ENCODINGS.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}
            </Select>
          </Field>
        )}
        {f.kind === "excel" && (
          <Field id="fr-sheet" label="Sheet" note="Empty: the first sheet. A name with * matches, e.g. ACT*.">
            <Input id="fr-sheet" value={f.sheet.kind === "first" ? "" : f.sheet.kind === "name" ? f.sheet.name : f.sheet.pattern}
              onChange={(e) => { const v = e.target.value.trim(); onChange({ ...f, sheet: !v ? { kind: "first" } : v.includes("*") ? { kind: "pattern", pattern: v } : { kind: "name", name: v } }); }} />
          </Field>
        )}
        <Field id="fr-top" label="Rows skipped at the top">
          <Input id="fr-top" inputMode="numeric" value={String(f.skip_top ?? 0)} onChange={(e) => onChange(withSkip(f, "skip_top", count(e.target.value)))} />
        </Field>
        <Field id="fr-bottom" label="Rows skipped at the end">
          <Input id="fr-bottom" inputMode="numeric" value={String(f.skip_bottom ?? 0)} onChange={(e) => onChange(withSkip(f, "skip_bottom", count(e.target.value)))} />
        </Field>
      </div>
      <span className="inline-flex items-center gap-2">
        <Switch id="fr-header" checked={f.header} onChange={(e) => onChange({ ...f, header: e.target.checked })} aria-label="The first row read is a header" />
        <label htmlFor="fr-header" className="text-body text-fg">The first row read is a header</label>
      </span>
      {f.kind === "fixed_width" && <Ruler line={firstLine} columns={f.columns} onChange={(columns) => onChange({ ...f, columns })} />}
      {f.kind !== "excel" && f.records && (
        <div className="grid gap-2">
          <p className="text-label text-fg">Record types</p>
          {f.records.types.map((t, i) => (
            <div key={t.code} className="flex flex-wrap items-center gap-2 text-body-sm">
              <span className="w-16 font-mono">{t.code}</span>
              <Select aria-label={`Role of record type ${t.code}`} value={t.role} className="h-8 w-40"
                onChange={(e) => onChange({ ...f, records: { ...f.records!, types: f.records!.types.map((x, k) => (k === i ? { ...x, role: e.target.value as typeof x.role } : x)) } } as FileFormat)}>
                <option value="header">Header</option><option value="detail">Detail</option><option value="skip">Skip</option>
              </Select>
              <span className="text-fg-3">{t.count} columns</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A sample line in mono: a press between two characters starts a column there, or removes the start that is there. */
function Ruler({ line, columns, onChange }: { line: string; columns: { start: number; length: number }[]; onChange: (c: { start: number; length: number }[]) => void }) {
  const starts = new Set(columns.map((c) => c.start));
  return (
    <div className="grid gap-1">
      <p className="text-label text-fg">Columns: press where a column starts</p>
      <div className="scroll-quiet flex overflow-x-auto rounded-md border border-line p-2 font-mono text-body-sm">
        {[...line].map((ch, i) => (
          <button key={i} type="button" aria-label={`${starts.has(i + 1) ? "Remove the column start at" : "Start a column at"} character ${i + 1}`}
            aria-pressed={starts.has(i + 1)} onClick={() => onChange(toggleBoundary(columns, i + 1))}
            className={`min-w-[1ch] whitespace-pre ${starts.has(i + 1) && i > 0 ? "border-l-2 border-primary" : "border-l-2 border-transparent"} hover:bg-tray`}>{ch}</button>
        ))}
      </div>
    </div>
  );
}
