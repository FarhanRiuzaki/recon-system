// The preview of a source version (route in sources): rows through type → map, answered as the rows that would enter
// `record` and the lines that would be quarantined. Nothing is stored. A file source's text sample is parsed first
// (Task 3); a database source's rows come pulled by a connector (Task 4), SQL NULL as null. Counts cover the whole
// sample; the lists show the first PREVIEW_LIST of each.
import type { SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import type { Row } from "./connectors";
import { type CalendarData, makeCalendar, toRecord } from "./map";
import { parseText } from "./parse";
import { profile } from "./profile";

export const PREVIEW_LIST = 100;

type Line = { line: number; ok: true; raw: Record<string, string | null> } | { line: number; ok: false; cells: string[]; reasons: Record<string, string> };

function preview(spec: SourceSpec, lines: Line[], calendar: CalendarData, fileName?: string, arrivedDate?: string): SourcePreviewDto {
  const cal = makeCalendar(calendar);
  const names = spec.fields.map((f) => f.name);
  const cells = (raw: Record<string, string | null>) => names.map((n) => raw[n] ?? "");
  const out: SourcePreviewDto = { lines: lines.length, ok: 0, skipped: 0, quarantined: 0, columns: [], records: [], quarantine: [] };
  const quarantine = (line: number, cells: string[], reasons: Record<string, string>) => {
    out.quarantined++;
    if (out.quarantine.length < PREVIEW_LIST) out.quarantine.push({ line, cells, reasons });
  };
  for (const l of lines) {
    if (!l.ok) { quarantine(l.line, l.cells, l.reasons); continue; }
    const r = toRecord(l.raw, spec, { calendar: cal, fileName, arrivedDate });
    if (!r.ok && r.left) { out.skipped++; continue; }
    if (!r.ok) { quarantine(l.line, cells(l.raw), r.reasons); continue; }
    out.ok++;
    const x = r.record;
    if (out.records.length < PREVIEW_LIST) out.records.push({
      line: l.line, businessDate: x.business_date, bdayIndex: x.bday_index, amountMinor: x.amount_minor?.toString() ?? null, amountText: x.amount_text, currency: x.currency,
      direction: x.direction, eventTime: x.event_time, extRef: x.ext_ref, accountRef: x.account_ref, attrs: x.attrs, naturalKey: x.natural_key, rowHash: x.row_hash,
    });
  }
  out.columns = profile(names, lines.flatMap((l) => (l.ok ? [cells(l.raw)] : [])));
  return out;
}

/** `spec` must be a file source (its `input.format` says how to read the text); `fileName` gives a business date taken from the name. */
export async function previewSample(spec: SourceSpec, sample: string, calendar: CalendarData, fileName?: string): Promise<SourcePreviewDto> {
  if (spec.input.kind !== "file_inbox") throw new Error("preview reads a file sample");
  return preview(spec, await parseText(sample, spec.input.format, spec.fields.map((f) => f.name)), calendar, fileName);
}

/** Rows a connector pulled (line = position in the sample, from 1). */
/** `arrivedDate`: a snapshot's business date (its rows are dated by it). */
export function previewRows(spec: SourceSpec, rows: Row[], calendar: CalendarData, arrivedDate?: string): SourcePreviewDto {
  return preview(spec, rows.map((raw, i) => ({ line: i + 1, ok: true, raw })), calendar, undefined, arrivedDate);
}
