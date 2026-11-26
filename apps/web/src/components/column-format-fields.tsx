"use client";

// A column's format (packages/shared report-format.ts) as fields: as is, a number (decimals, thousands, negative,
// before, after), a date (its pattern) or text (its letters), with a live example. One editor for the report
// designer's columns and a recon's Operation result columns, so a format reads the same in both.
import type { ColumnFormat } from "@starterkit/shared/contracts/reports";
import { formatCell } from "@starterkit/shared/report-format";
import { DATE_PATTERNS } from "@starterkit/shared/reports";
import { Field, FormatExample, Segmented } from "@starterkit/ui/ds";
import { Input } from "@starterkit/ui/ui/input";
import { Select } from "@starterkit/ui/ui/select";

/** A new number format: whole numbers, dots between thousands, a minus sign, nothing around it. */
export const NUMBER_FORMAT: Extract<ColumnFormat, { kind: "number" }> = { kind: "number", decimals: 0, thousands: ".", negative: "minus", prefix: "", suffix: "" };

/**
 * The format fields of one column. `id` prefixes the fields' ids (unique on the page); `onChange` gets the new format and,
 * for a typed affix, a key that names the field (the designer folds a run of keystrokes into one undo step).
 * `number` = the number format a switch to Number starts from.
 */
export function ColumnFormatFields({ id, value, onChange, number = NUMBER_FORMAT }: {
  id: string; value: ColumnFormat; onChange: (f: ColumnFormat, key?: string) => void; number?: Extract<ColumnFormat, { kind: "number" }>;
}) {
  return (
    <div className="grid gap-list">
      <Segmented label="Format" value={value.kind} options={[{ value: "auto", label: "As is" }, { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "text", label: "Text" }]}
        onChange={(k) => onChange(k === "number" ? number : k === "date" ? { kind: "date", pattern: "dd/MM/yyyy" } : k === "text" ? { kind: "text", case: "as_is" } : { kind: "auto" })} />
      {value.kind === "number" && <>
        <div className="grid grid-cols-2 gap-list">
          <Field id={`${id}-dec`} label="Decimals"><Select className="w-full" id={`${id}-dec`} value={String(value.decimals)} onChange={(e) => onChange({ ...value, decimals: Number(e.target.value) })}>{[0, 1, 2, 3, 4].map((d) => <option key={d}>{d}</option>)}</Select></Field>
          <Field id={`${id}-thou`} label="Thousands"><Select className="w-full" id={`${id}-thou`} value={value.thousands} onChange={(e) => onChange({ ...value, thousands: e.target.value as "." })}><option value=".">1.000.000</option><option value=",">1,000,000</option><option value="none">1000000</option></Select></Field>
          <Field id={`${id}-neg`} label="Negative"><Select className="w-full" id={`${id}-neg`} value={value.negative} onChange={(e) => onChange({ ...value, negative: e.target.value as "minus" })}><option value="minus">-1.500</option><option value="paren">(1.500)</option><option value="trailing">1.500-</option></Select></Field>
          <Field id={`${id}-pre`} label="Before" optional><Input id={`${id}-pre`} value={value.prefix} maxLength={10} placeholder="Rp " onChange={(e) => onChange({ ...value, prefix: e.target.value }, "prefix")} /></Field>
          <Field id={`${id}-suf`} label="After" optional><Input id={`${id}-suf`} value={value.suffix} maxLength={10} placeholder=" IDR" onChange={(e) => onChange({ ...value, suffix: e.target.value }, "suffix")} /></Field>
        </div>
        <FormatExample items={[formatCell(-1234567.891, value), formatCell(98000000, value)]} />
      </>}
      {value.kind === "date" && <>
        <Field id={`${id}-date`} label="Date as"><Select className="w-full" id={`${id}-date`} value={value.pattern} onChange={(e) => onChange({ kind: "date", pattern: e.target.value as "dd/MM/yyyy" })}>{DATE_PATTERNS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <FormatExample items={[formatCell("2026-11-05", value)]} />
      </>}
      {value.kind === "text" && <Field id={`${id}-case`} label="Letters"><Select className="w-full" id={`${id}-case`} value={value.case} onChange={(e) => onChange({ kind: "text", case: e.target.value as "as_is" })}><option value="as_is">As they are</option><option value="upper">UPPER CASE</option><option value="lower">lower case</option></Select></Field>}
    </div>
  );
}
