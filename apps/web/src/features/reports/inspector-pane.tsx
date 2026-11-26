"use client";

// The designer's right pane (spec 2026-11-26 "Designer UX"): the settings of what is selected. A column: its header,
// what it holds (a field with a fallback, a formula, fixed text, the row number), its format with a live example, a
// highlight, its total and its layout. A section: the title's text, the header block's lines, the footer. Nothing
// selected: the whole report (name, official, when, masking, the file).
import type { ColumnFormat, HeaderLine, ReportColumn, ReportSpec } from "@starterkit/shared/contracts/reports";
import { formatCell } from "@starterkit/shared/report-format";
import { DATE_PATTERNS } from "@starterkit/shared/reports";
import { Field, FormatExample, Inspector, InspectorSection, type ListedField, Notice, Segmented, SwitchRow } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, CopyIcon, RemoveIcon } from "@starterkit/ui/ui/icons";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";
import { Textarea } from "@starterkit/ui/ui/textarea";
import type { Selected } from "./report-canvas";
import { useState } from "react";
import { refLabel } from "./report-text";
import { duplicateColumn, patchColumn, removeColumn, widthOf } from "./spec-model";

type Change = (fn: (s: ReportSpec) => ReportSpec, said?: string, key?: string) => void;

/** The width as typed (it may be empty for a moment); a valid number goes to the design, leaving the field restores it. */
function WidthInput({ id, value, onWidth }: { id: string; value: number; onWidth: (w: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <Input id={id} type="number" min={1} max={200} value={draft ?? String(value)} onBlur={() => setDraft(null)}
    onChange={(e) => { setDraft(e.target.value); const w = widthOf(e.target.value); if (w !== null) onWidth(w); }} />;
}
const NUMBER: Extract<ColumnFormat, { kind: "number" }> = { kind: "number", decimals: 0, thousands: ".", negative: "minus", prefix: "", suffix: "" };
const TOKENS = "{recon}, {template}, {date}, {from}, {to}, {made_at}";

function ColumnInspector({ spec, c, change, fields, sample, problem, readOnly, select }: {
  spec: ReportSpec; c: ReportColumn; change: Change; fields: Map<string, ListedField>; sample: string | null; problem: string | null; readOnly: boolean; select: (s: Selected) => void;
}) {
  const set = (patch: Partial<ReportColumn>, said?: string, key?: string) => change((s) => patchColumn(s, c.id, patch), said, key);
  const f = c.content.kind === "field" ? fields.get(c.content.ref) : undefined;
  const options = [...fields.values()];
  const numericFields = options.filter((x) => x.type === "number");
  const total = spec.totals.columns[c.id] ?? "";
  const format = c.format;
  return (
    <Inspector title="Column" meta={`${spec.columns.indexOf(c) + 1} of ${spec.columns.length}`}>
      <fieldset disabled={readOnly} className="grid min-w-0 gap-1">
        <InspectorSection title="Header">
          <Input aria-label="Column header" placeholder="No heading" value={c.header} onChange={(e) => set({ header: e.target.value }, undefined, `${c.id}:header`)} />
        </InspectorSection>
        <InspectorSection title="Holds">
          <Segmented label="What the column holds" value={c.content.kind} options={[{ value: "field", label: "Field" }, { value: "formula", label: "Formula" }, { value: "text", label: "Text" }, { value: "rownum", label: "Row no." }]}
            onChange={(k) => set({ content: k === "field" ? { kind: "field", ref: options[0]?.ref ?? "recon:status" } : k === "formula" ? { kind: "formula", cel: "a.amount_minor - b.amount_minor" } : k === "text" ? { kind: "text", text: "" } : { kind: "rownum" } })} />
          {c.content.kind === "field" && <>
            <Field id="col-field" label="Field" required>
              <Select id="col-field" value={c.content.ref} onChange={(e) => { const x = fields.get(e.target.value); set({ content: { kind: "field", ref: e.target.value }, ...(x ? { header: x.label } : {}) }); }}>
                {!fields.has(c.content.ref) && <option value={c.content.ref}>{refLabel(c.content.ref, fields)} (not in the data)</option>}
                {options.map((x) => <option key={x.ref} value={x.ref}>{x.label}</option>)}
              </Select>
            </Field>
            <Field id="col-fallback" label="If empty, use" optional>
              <Select id="col-fallback" value={c.content.fallback ?? ""} onChange={(e) => set({ content: { kind: "field", ref: (c.content as { ref: string }).ref, ...(e.target.value ? { fallback: e.target.value } : {}) } })}>
                <option value="">Leave it empty</option>
                {options.map((x) => <option key={x.ref} value={x.ref}>{x.label}</option>)}
              </Select>
            </Field>
          </>}
          {c.content.kind === "formula" && (
            <Field id="col-cel" label="Formula" required error={problem} note={problem ? undefined : sample !== null ? `On the first row: ${sample || "(empty)"}` : "Fields by name: a.amount_minor, b.ext_ref, a.attrs.member, recon.reason."}>
              <Textarea id="col-cel" className="font-mono" rows={3} spellCheck={false} value={c.content.cel} onChange={(e) => set({ content: { kind: "formula", cel: e.target.value } }, undefined, `${c.id}:cel`)} />
            </Field>
          )}
          {c.content.kind === "formula" && numericFields.length > 0 && (
            <div role="group" className="flex flex-wrap gap-2" aria-label="Insert a field">
              {numericFields.slice(0, 8).map((x) => <Button key={x.ref} type="button" variant="secondary" size="sm" aria-label={`Insert ${x.label} into the formula`} onClick={() => set({ content: { kind: "formula", cel: `${(c.content as { cel: string }).cel} ${x.ref.replace(":", ".")}`.trim() } })}><Icon icon={AddIcon} />{x.label}</Button>)}
            </div>
          )}
          {c.content.kind === "text" && <Input aria-label="Text in every row" value={c.content.text} onChange={(e) => set({ content: { kind: "text", text: e.target.value } }, undefined, `${c.id}:text`)} />}
          {c.content.kind === "rownum" && <p className="text-body-sm text-fg-3">Counts the rows: 1, 2, 3 … through the file.</p>}
          {f?.customer && <Notice tone="info">Customer data: shown masked (last 4 kept). Only an official report approved as full shows it whole.</Notice>}
        </InspectorSection>
        <InspectorSection title="Format">
          <Segmented label="Format" value={format.kind} options={[{ value: "auto", label: "As is" }, { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "text", label: "Text" }]}
            onChange={(k) => set({ format: k === "number" ? NUMBER : k === "date" ? { kind: "date", pattern: "dd/MM/yyyy" } : k === "text" ? { kind: "text", case: "as_is" } : { kind: "auto" } })} />
          {format.kind === "number" && <>
            <div className="grid grid-cols-2 gap-list">
              <Field id="fmt-dec" label="Decimals"><Select id="fmt-dec" value={String(format.decimals)} onChange={(e) => set({ format: { ...format, decimals: Number(e.target.value) } })}>{[0, 1, 2, 3, 4].map((d) => <option key={d}>{d}</option>)}</Select></Field>
              <Field id="fmt-thou" label="Thousands"><Select id="fmt-thou" value={format.thousands} onChange={(e) => set({ format: { ...format, thousands: e.target.value as "." } })}><option value=".">1.000.000</option><option value=",">1,000,000</option><option value="none">1000000</option></Select></Field>
              <Field id="fmt-neg" label="Negative"><Select id="fmt-neg" value={format.negative} onChange={(e) => set({ format: { ...format, negative: e.target.value as "minus" } })}><option value="minus">-1.500</option><option value="paren">(1.500)</option><option value="trailing">1.500-</option></Select></Field>
              <Field id="fmt-pre" label="Before" optional><Input id="fmt-pre" value={format.prefix} maxLength={10} placeholder="Rp " onChange={(e) => set({ format: { ...format, prefix: e.target.value } }, undefined, `${c.id}:prefix`)} /></Field>
            </div>
            <FormatExample items={[formatCell(-1234567.891, format), formatCell(98000000, format)]} />
          </>}
          {format.kind === "date" && <>
            <Field id="fmt-date" label="Date as"><Select id="fmt-date" value={format.pattern} onChange={(e) => set({ format: { kind: "date", pattern: e.target.value as "dd/MM/yyyy" } })}>{DATE_PATTERNS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <FormatExample items={[formatCell("2026-11-05", format)]} />
          </>}
          {format.kind === "text" && <Field id="fmt-case" label="Letters"><Select id="fmt-case" value={format.case} onChange={(e) => set({ format: { kind: "text", case: e.target.value as "as_is" } })}><option value="as_is">As they are</option><option value="upper">UPPER CASE</option><option value="lower">lower case</option></Select></Field>}
          <Field id="col-hl" label="Highlight">
            <Select id="col-hl" value={c.highlight ? `${c.highlight.when}:${c.highlight.style}` : ""} onChange={(e) => {
              const [when, style] = e.target.value.split(":") as ["not_zero", "red"];
              set({ highlight: e.target.value ? { when, style } : undefined });
            }}>
              <option value="">Never</option><option value="not_zero:red">In red when not zero</option><option value="negative:red">In red when negative</option><option value="empty:bold">In bold when empty</option>
            </Select>
          </Field>
          <Field id="col-total" label="Total">
            <Select id="col-total" value={total} onChange={(e) => change((s) => {
              const { [c.id]: _x, ...rest } = s.totals.columns;
              return { ...s, totals: { ...s.totals, on: e.target.value ? true : s.totals.on, columns: e.target.value ? { ...rest, [c.id]: e.target.value as "sum" } : rest } };
            })}>
              <option value="">None</option><option value="sum">Sum</option><option value="count">Count of rows</option>
            </Select>
          </Field>
        </InspectorSection>
        <InspectorSection title="Layout">
          <Segmented label="Align" value={c.layout.align} options={[{ value: "l", label: "Left" }, { value: "c", label: "Centre" }, { value: "r", label: "Right" }]} onChange={(a) => set({ layout: { ...c.layout, align: a } })} />
          <div className="grid grid-cols-2 gap-list">
            <Field id="col-width" label={spec.output.format === "txt" ? "Width (characters)" : "Width"}>
              <WidthInput id="col-width" value={c.layout.width} onWidth={(w) => set({ layout: { ...c.layout, width: w } }, undefined, `${c.id}:width`)} />
            </Field>
            {spec.output.format === "txt" && (
              <Field id="col-pad" label="Fill with"><Select id="col-pad" value={c.layout.pad} onChange={(e) => set({ layout: { ...c.layout, pad: e.target.value as " " } })}><option value=" ">Spaces</option><option value="0">Zeros (numbers)</option></Select></Field>
            )}
          </div>
        </InspectorSection>
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => change((s) => duplicateColumn(s, c.id), `Duplicated “${c.header}”`)}><Icon icon={CopyIcon} />Duplicate</Button>
          <Button type="button" variant="remove" size="sm" onClick={() => { change((s) => removeColumn(s, c.id), `Removed “${c.header}”`); select({ kind: "report" }); }}><Icon icon={RemoveIcon} />Remove column</Button>
        </div>
      </fieldset>
    </Inspector>
  );
}

function HeaderLines({ spec, change, fields }: { spec: ReportSpec; change: Change; fields: Map<string, ListedField> }) {
  const lines = spec.sections.header.lines;
  const setLines = (next: HeaderLine[], said?: string) => change((s) => ({ ...s, sections: { ...s.sections, header: { ...s.sections.header, lines: next } } }), said);
  const put = (i: number, l: HeaderLine) => setLines(lines.map((x, k) => (k === i ? l : x)));
  return (
    <div className="grid gap-3">
      {lines.map((l, i) => (
        <div key={i} className="grid gap-2 rounded-ctl border border-line p-2">
          <Input aria-label={`Line ${i + 1} label`} placeholder="Label" value={l.label} onChange={(e) => put(i, { ...l, label: e.target.value })} />
          <Select aria-label={`Line ${i + 1} value`} value={l.value.kind} onChange={(e) => {
            const k = e.target.value;
            put(i, { ...l, value: k === "text" ? { kind: "text", text: "" } : k === "count" ? { kind: "count" } : { kind: k as "field", ref: [...fields.keys()][0] ?? "recon:status" } });
          }}>
            <option value="text">Fixed text</option><option value="field">A field of the first row</option><option value="count">Number of rows</option><option value="sum">Sum of a field</option>
          </Select>
          {l.value.kind === "text" && <Input aria-label={`Line ${i + 1} text`} value={l.value.text} placeholder={TOKENS} onChange={(e) => put(i, { ...l, value: { kind: "text", text: e.target.value } })} />}
          {(l.value.kind === "field" || l.value.kind === "sum") && (
            <Select aria-label={`Line ${i + 1} field`} value={l.value.ref} onChange={(e) => put(i, { ...l, value: { kind: (l.value as { kind: "field" }).kind, ref: e.target.value } })}>
              {[...fields.values()].filter((f) => l.value.kind !== "sum" || f.type === "number").map((f) => <option key={f.ref} value={f.ref}>{f.label}</option>)}
            </Select>
          )}
          <Button type="button" variant="remove" size="sm" className="justify-self-start" onClick={() => setLines(lines.filter((_, k) => k !== i), "Line removed")}><Icon icon={RemoveIcon} />Remove line</Button>
        </div>
      ))}
      <Button type="button" variant="create" size="sm" className="justify-self-start" onClick={() => setLines([...lines, { label: "", value: { kind: "text", text: "" } }])}><Icon icon={AddIcon} />Add a line</Button>
    </div>
  );
}

function ReportInspector({ spec, change, name, onName }: { spec: ReportSpec; change: Change; name: string; onName: (n: string) => void }) {
  const o = spec.output;
  const flat = o.format === "csv" || o.format === "txt";
  const out = (patch: Partial<ReportSpec["output"]>) => change((s) => ({ ...s, output: { ...s.output, ...patch } }));
  return (
    <Inspector title="Whole report" meta="Press a column or a section to change it">
      <InspectorSection title="Report">
        <Field id="rep-name" label="Name" required error={name.trim() ? null : "Name the report."}><Input id="rep-name" value={name} onChange={(e) => onName(e.target.value)} /></Field>
        <SwitchRow checked={spec.official} label="Official report" description="A config checker approves each version." onChange={() => change((s) => ({ ...s, official: !s.official, output: { ...s.output, masking: s.official ? "masked" : s.output.masking } }))} />
        <SwitchRow checked={spec.when.afterRun} label="Make it after every run" onChange={() => change((s) => ({ ...s, when: { ...s.when, afterRun: !s.when.afterRun } }))} />
        <SwitchRow checked={spec.when.onRequest} label="Make it on request" onChange={() => change((s) => ({ ...s, when: { ...s.when, onRequest: !s.when.onRequest } }))} />
        <Field id="rep-mask" label="Customer data" note={spec.official ? undefined : "Full needs an official report."}>
          <Select id="rep-mask" value={o.masking} onChange={(e) => out({ masking: e.target.value as "masked" })}>
            <option value="masked">Masked (last 4 kept)</option>{spec.official && <option value="full">Full (space admin, reviewer, config checker download)</option>}
          </Select>
        </Field>
      </InspectorSection>
      <InspectorSection title="File">
        <Field id="rep-file" label="File name" required error={o.fileName.trim() ? null : "Name the file."} note={`Uses ${TOKENS.replace(", {made_at}", "")}`}><Input id="rep-file" className="font-mono" value={o.fileName} onChange={(e) => change((s) => ({ ...s, output: { ...s.output, fileName: e.target.value } }), undefined, "fileName")} /></Field>
        {o.format === "csv" && (
          <div className="grid grid-cols-2 gap-list">
            <Field id="rep-delim" label="Separator"><Select id="rep-delim" value={o.csv.delimiter} onChange={(e) => out({ csv: { ...o.csv, delimiter: e.target.value as "," } })}><option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value={"\t"}>Tab</option><option value="|">Pipe |</option></Select></Field>
            <Field id="rep-quote" label="Quotes"><Select id="rep-quote" value={o.csv.quote} onChange={(e) => out({ csv: { ...o.csv, quote: e.target.value as "auto" } })}><option value="auto">When needed</option><option value="all">Every cell</option></Select></Field>
          </div>
        )}
        {flat && <>
          <div className="grid grid-cols-2 gap-list">
            <Field id="rep-eol" label="Line ends"><Select id="rep-eol" value={o.lineEnding} onChange={(e) => out({ lineEnding: e.target.value as "crlf" })}><option value="crlf">Windows (CRLF)</option><option value="lf">Unix (LF)</option></Select></Field>
            <Field id="rep-enc" label="Characters"><Select id="rep-enc" value={o.encoding} onChange={(e) => out({ encoding: e.target.value as "utf8" })}><option value="utf8">UTF-8</option><option value="ascii">ASCII only</option></Select></Field>
          </div>
          <SwitchRow checked={o.groupLines} label="Group and subtotal lines in the file" onChange={() => out({ groupLines: !o.groupLines })} />
        </>}
        <SwitchRow checked={spec.totals.perGroup} label="A subtotal under each group" onChange={() => change((s) => ({ ...s, totals: { ...s.totals, perGroup: !s.totals.perGroup } }))} />
      </InspectorSection>
    </Inspector>
  );
}

export function InspectorPane({ spec, selected, select, change, fields, preview, readOnly, name, onName }: {
  spec: ReportSpec; selected: Selected; select: (s: Selected) => void; change: Change; fields: Map<string, ListedField>;
  preview: { cell: (id: string) => string | null; problem: (id: string) => string | null }; readOnly: boolean; name: string; onName: (n: string) => void;
}) {
  if (selected.kind === "column") {
    const c = spec.columns.find((x) => x.id === selected.id);
    if (c) return <ColumnInspector spec={spec} c={c} change={change} fields={fields} sample={preview.cell(c.id)} problem={preview.problem(c.id)} readOnly={readOnly} select={select} />;
  }
  if (selected.kind === "section") {
    const s = spec.sections;
    const k = selected.key;
    return (
      <Inspector title={k === "title" ? "Title" : k === "header" ? "Header block" : "Footer"}>
        <fieldset disabled={readOnly} className="grid min-w-0 gap-3">
          {k === "title" && <Field id="sec-title" label="Title" optional note={`Uses ${TOKENS}`}><Input id="sec-title" value={s.title.text} onChange={(e) => change((x) => ({ ...x, sections: { ...x.sections, title: { ...x.sections.title, text: e.target.value } } }), undefined, "title")} /></Field>}
          {k === "header" && <HeaderLines spec={spec} change={change} fields={fields} />}
          {k === "footer" && <>
            <Field id="sec-foot" label="Text" optional note={`Uses ${TOKENS}`}><Input id="sec-foot" value={s.footer.text} placeholder="Confidential · for OJK" onChange={(e) => change((x) => ({ ...x, sections: { ...x.sections, footer: { ...x.sections.footer, text: e.target.value } } }), undefined, "footer")} /></Field>
            <SwitchRow checked={s.footer.stamp} label="Final or Not final stamp" onChange={() => change((x) => ({ ...x, sections: { ...x.sections, footer: { ...x.sections.footer, stamp: !x.sections.footer.stamp } } }))} />
            <SwitchRow checked={s.footer.pageNumbers} label="Page numbers" description="In a PDF only." onChange={() => change((x) => ({ ...x, sections: { ...x.sections, footer: { ...x.sections.footer, pageNumbers: !x.sections.footer.pageNumbers } } }))} />
          </>}
        </fieldset>
      </Inspector>
    );
  }
  return <fieldset disabled={readOnly} className="min-w-0"><ReportInspector spec={spec} change={change} name={name} onName={onName} /></fieldset>;
}
