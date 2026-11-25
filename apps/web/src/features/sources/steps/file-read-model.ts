// "How the file is read" (the file reader, DEC-058), pure: the one-line summary of a format, a fixed-length column
// boundary added or removed, and the words for each row's role in the detected preview.
import type { DetectDto, FileFormat } from "@starterkit/shared/contracts/sources";

type Role = Extract<DetectDto, { supported: true }>["rows"][number]["role"];
type Pos = { start: number; length: number };

const DELIMITER_NAME: Record<string, string> = { ",": "Comma ,", ";": "Semicolon ;", "|": "Pipe |", "\t": "Tab" };
const rows = (n: number, where: string) => `${n} ${n === 1 ? "row" : "rows"} skipped ${where}`;

/** The format in one line, after the file's name. */
export function summaryOf(f: FileFormat, fileName: string): string {
  const parts = [fileName];
  if (f.kind === "delimited") parts.push("Delimited", DELIMITER_NAME[f.delimiter] ?? `"${f.delimiter}"`, f.encoding.toUpperCase());
  if (f.kind === "fixed_width") parts.push("Fixed length", `${f.columns.length} columns`, f.encoding.toUpperCase());
  if (f.kind === "excel") parts.push("Excel", f.sheet.kind === "first" ? "First sheet" : f.sheet.kind === "name" ? `Sheet ${f.sheet.name}` : `Sheet matching ${f.sheet.pattern}`);
  const records = f.kind !== "excel" ? f.records : undefined;
  if (records) {
    const of = (role: string) => records.types.filter((t) => t.role === role).map((t) => t.code).join(", ");
    parts.push([of("header") && `Header lines ${of("header")}`, `detail lines ${of("detail")}`, of("skip") && `skipped ${of("skip")}`].filter(Boolean).join(", "));
  } else {
    parts.push(f.header ? `Header on row ${(f.skip_top ?? 0) + 1}` : "No header");
    if (f.skip_top && !f.header) parts.push(rows(f.skip_top, "at the top"));
  }
  if (f.skip_bottom) parts.push(rows(f.skip_bottom, "at the end"));
  return parts.join(" · ");
}

/** Fixed-length columns with a column start at character `at` (1-based) added, or removed when there is one (the first stays). */
export function toggleBoundary(cols: readonly Pos[], at: number): Pos[] {
  const starts = cols.map((c) => c.start);
  const end = Math.max(...cols.map((c) => c.start + c.length));
  const next = starts.includes(at) ? (at === starts[0] ? starts : starts.filter((s) => s !== at)) : [...starts, at].sort((a, b) => a - b);
  return next.map((s, i) => ({ start: s, length: (next[i + 1] ?? end) - s }));
}

/** What each row of the preview is. */
export const ROLE_LABEL: Record<Role, string> = {
  skipped: "Skipped", header: "Header", detail: "Row", record_header: "Record header", trailer: "Trailer", quarantined: "Can't be read",
};

/**
 * The saved folder whose newest file an existing file source reads as its sample when it is opened (whoever edits it:
 * a config maker reads the sample's rows too; once per visit): without it, editing showed no sample and step 2 had no examples.
 */
export function storedSampleRead(input: { kind: string; path?: string; pattern?: string }, o: { created: boolean; already: boolean }): { path: string; pattern: string } | null {
  if (input.kind !== "file_inbox" || !o.created || o.already || !input.path?.trim()) return null;
  return { path: input.path.trim(), pattern: input.pattern?.trim() || "*" };
}
