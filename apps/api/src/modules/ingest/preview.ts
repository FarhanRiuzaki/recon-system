// The preview of a source version (Task 3; route in sources): a text sample through parse → type → map, answered as the
// rows that would enter `record` and the lines that would be quarantined. Nothing is stored. Counts cover the whole
// sample; the lists show the first PREVIEW_LIST of each.
import type { SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { type CalendarData, makeCalendar, toRecord } from "./map";
import { parseText } from "./parse";
import { profile } from "./profile";

export const PREVIEW_LIST = 100;

/** `spec` must be a file source (its `input.format` says how to read the text); `fileName` gives a business date taken from the name. */
export async function previewSample(spec: SourceSpec, sample: string, calendar: CalendarData, fileName?: string): Promise<SourcePreviewDto> {
  if (spec.input.kind !== "file_inbox") throw new Error("preview reads a file sample");
  const cal = makeCalendar(calendar);
  const names = spec.fields.map((f) => f.name);
  const parsed = await parseText(sample, spec.input.format, names);
  const out: SourcePreviewDto = { lines: parsed.length, ok: 0, quarantined: 0, columns: [], records: [], quarantine: [] };
  const quarantine = (line: number, cells: string[], reasons: Record<string, string>) => {
    out.quarantined++;
    if (out.quarantine.length < PREVIEW_LIST) out.quarantine.push({ line, cells, reasons });
  };
  for (const l of parsed) {
    if (!l.ok) { quarantine(l.line, l.cells, l.reasons); continue; }
    const r = toRecord(l.raw, spec, { calendar: cal, fileName });
    if (!r.ok) { quarantine(l.line, names.map((n) => l.raw[n]!), r.reasons); continue; }
    out.ok++;
    const x = r.record;
    if (out.records.length < PREVIEW_LIST) out.records.push({
      line: l.line, businessDate: x.business_date, bdayIndex: x.bday_index, amountMinor: x.amount_minor?.toString() ?? null, currency: x.currency,
      direction: x.direction, eventTime: x.event_time, extRef: x.ext_ref, accountRef: x.account_ref, attrs: x.attrs, naturalKey: x.natural_key, rowHash: x.row_hash,
    });
  }
  out.columns = profile(names, parsed.flatMap((l) => (l.ok ? [names.map((n) => l.raw[n]!)] : [])));
  return out;
}
