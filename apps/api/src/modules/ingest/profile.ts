// A sample of up to 200 rows to what the mapping wizard shows per column: a guessed type (with the date format it was
// read in), examples, the share empty. A guess, never a rule: the person confirms the type. Digit strings with a
// leading zero stay text (SIDs, account numbers); eight digits that are all real dates from 1990 to 2100 are a date
// read as yyyyMMdd (20261119), not a number.
import type { FIELD_TYPES } from "@starterkit/shared/sources";

export const PROFILE_ROWS = 200;
export type ColumnProfile = { name: string; type: (typeof FIELD_TYPES)[number]; format: string | null; examples: string[]; emptyPct: number };

const GUESSES: [ColumnProfile["type"], RegExp][] = [
  ["boolean", /^(true|false)$/i],
  ["integer", /^(0|[+-]?[1-9]\d*)$/],
  ["decimal", /^[+-]?(0|[1-9]\d*)([.,]\d+)?$/], // after integer: a column of 100.50 and 7 is a decimal
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["datetime", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/],
];

/** Eight digits that are a real calendar date between 1990 and 2100 (20261119 yes; 20261340 and 12345678 no). */
function compactDate(c: string): boolean {
  if (!/^\d{8}$/.test(c)) return false;
  const y = Number(c.slice(0, 4)), m = Number(c.slice(4, 6)), d = Number(c.slice(6, 8));
  if (y < 1990 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `columns` and `rows` (cells in column order): per column, its name, guessed type, up to 3 distinct non-empty examples and the percentage of empty cells (one decimal). */
export function profile(columns: string[], rows: string[][]): ColumnProfile[] {
  const sample = rows.slice(0, PROFILE_ROWS);
  return columns.map((name, i) => {
    const cells = sample.map((r) => (r[i] ?? "").trim());
    const filled = cells.filter((c) => c !== "");
    const compact = filled.length > 0 && filled.every(compactDate);
    const type = compact ? "date" : filled.length ? (GUESSES.find(([, re]) => filled.every((c) => re.test(c)))?.[0] ?? "string") : "string";
    return {
      name, type, format: compact ? "yyyyMMdd" : type === "date" ? "yyyy-MM-dd" : null, examples: [...new Set(filled)].slice(0, 3),
      emptyPct: cells.length ? Math.round(((cells.length - filled.length) / cells.length) * 1000) / 10 : 0,
    };
  });
}
