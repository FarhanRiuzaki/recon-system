// Spec v2 helpers (spec 2026-11-26): the empty design a new template opens with, and the conversion of a v1 stored
// version (owner: v1 templates keep working), so a stored spec of either shape reads as v2.
import { ReportSpec, ReportSpecV1, type ReportColumn } from "./contracts/reports";

const AMOUNT = /(^|:)amount_minor$|^recap:amount_/;
// event_time is a moment, not a date: as is, so its time stays
const DATE = /^recon:businessDate$|^recap:date$|(^|:)business_date$/;

/** Whether a field holds a number (amounts in major units, counts, the match rate). */
export const numericRef = (ref: string) => AMOUNT.test(ref) || /^recap:(results|matched|breaks|match_rate|count_a|count_b)$/.test(ref);

/** A column on `ref` with the format its field suggests (amounts as numbers, dates as yyyy-MM-dd as v1 wrote them). */
export function columnFor(id: string, ref: string, header: string): ReportColumn {
  const numeric = numericRef(ref);
  return {
    id, header, content: { kind: "field", ref },
    format: numeric ? { kind: "number", decimals: AMOUNT.test(ref) ? 2 : 0, thousands: ".", negative: "minus", prefix: "", suffix: "" }
      : DATE.test(ref) ? { kind: "date", pattern: "yyyy-MM-dd" } : { kind: "auto" },
    layout: { align: numeric ? "r" : "l", width: Math.min(200, Math.max(12, header.length)), pad: " " },
  };
}

/** A new template's design: the recon's results, no column yet, every section on, CSV, masked, on request. */
export function emptySpec(): ReportSpec {
  return {
    v: 2, dataset: "results", rows: { filters: [] }, columns: [], groups: [], summaryOnly: false,
    totals: { on: true, perGroup: true, columns: {} },
    sections: { title: { on: true, text: "{template}" }, header: { on: true, lines: [] }, columnHeaders: true, footer: { on: true, stamp: true, pageNumbers: true, text: "" } },
    output: { format: "csv", fileName: "{recon}_{date}", masking: "masked", csv: { delimiter: ",", quote: "auto" }, lineEnding: "crlf", encoding: "utf8", groupLines: false },
    when: { afterRun: false, onRequest: true }, official: false,
  };
}

const RECAP_V1 = [["recap:date", "Business date"], ["recap:results", "Results"], ["recap:matched", "Matched"], ["recap:breaks", "Breaks"], ["recap:match_rate", "Match rate (%)"]] as const;

/** A v1 version as v2: same columns, rows, groups, totals and output (min/max totals have no v2 form and are dropped). */
export function fromV1(s: ReportSpecV1): ReportSpec {
  const e = emptySpec();
  // amounts as plain numbers (150000.00): a v1 file's numbers had no thousands separator, so a CSV stays unquoted
  const plain = (c: ReturnType<typeof columnFor>) => (c.format.kind === "number" ? { ...c, format: { ...c.format, thousands: "none" as const } } : c);
  const cols = (s.kind === "daily_summary" ? RECAP_V1.map(([r, h], i) => columnFor(`c${i + 1}`, r, h)) : s.columns.map((c, i) => columnFor(`c${i + 1}`, c.key, c.header))).map(plain);
  const idOf = new Map(s.columns.map((c, i) => [c.key, `c${i + 1}`]));
  const totals: Record<string, "sum" | "count"> = {};
  for (const t of s.totals) if (t.column && (t.fn === "sum" || t.fn === "count") && idOf.has(t.column)) totals[idOf.get(t.column)!] = t.fn;
  const filters: ReportSpec["rows"]["filters"] = [];
  if (s.rows.statuses.length) filters.push({ ref: "recon:status", op: "any_of", value: [...s.rows.statuses] });
  if (s.rows.side !== "both") filters.push({ ref: "recon:side", op: "any_of", value: [s.rows.side] });
  if (s.rows.reasons.length) filters.push({ ref: "recon:reason", op: "any_of", value: [...s.rows.reasons] });
  return {
    ...e, dataset: s.kind === "daily_summary" ? "recap" : "results", rows: { filters }, columns: cols,
    groups: s.kind === "grouped" ? [...s.groups] : [],
    // v1 wrote total lines only in a grouped report
    totals: { on: s.kind === "grouped" && s.totals.length > 0, perGroup: s.kind === "grouped", columns: totals },
    sections: {
      title: { on: !!s.output.title, text: s.output.title ?? "" },
      header: { on: !!s.output.subtitle, lines: s.output.subtitle ? [{ label: "", value: { kind: "text", text: s.output.subtitle } }] : [] },
      columnHeaders: true,
      footer: { on: s.output.format === "pdf", stamp: true, pageNumbers: true, text: "" },
    },
    output: { ...e.output, format: s.output.format, fileName: s.output.fileName, masking: s.output.masking, groupLines: s.kind === "grouped" },
    when: { ...s.when }, official: s.official,
  };
}

/** A stored version's spec as v2: v2 as it is, v1 converted (DEC-061: v1 versions are converted on read, not migrated). */
export function parseStoredSpec(json: unknown): ReportSpec {
  if (json && typeof json === "object" && (json as { v?: unknown }).v === 2) return ReportSpec.parse(json);
  return fromV1(ReportSpecV1.parse(json));
}
