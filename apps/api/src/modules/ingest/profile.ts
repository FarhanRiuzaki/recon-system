// A sample of up to 200 rows to what the mapping wizard shows per column: a guessed type, examples, the share empty.
// A guess, never a rule: the person confirms the type. Digit strings with a leading zero stay text (SIDs, account numbers).
import type { FIELD_TYPES } from "@starterkit/shared/sources";

export const PROFILE_ROWS = 200;
export type ColumnProfile = { name: string; type: (typeof FIELD_TYPES)[number]; examples: string[]; emptyPct: number };

const GUESSES: [ColumnProfile["type"], RegExp][] = [
  ["boolean", /^(true|false)$/i],
  ["integer", /^(0|[+-]?[1-9]\d*)$/],
  ["decimal", /^[+-]?(0|[1-9]\d*)([.,]\d+)?$/], // after integer: a column of 100.50 and 7 is a decimal
  ["date", /^(\d{4}-\d{2}-\d{2}|\d{8})$/],
  ["datetime", /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/],
];

/** `columns` and `rows` (cells in column order): per column, its name, guessed type, up to 3 distinct non-empty examples and the percentage of empty cells (one decimal). */
export function profile(columns: string[], rows: string[][]): ColumnProfile[] {
  const sample = rows.slice(0, PROFILE_ROWS);
  return columns.map((name, i) => {
    const cells = sample.map((r) => (r[i] ?? "").trim());
    const filled = cells.filter((c) => c !== "");
    const type = filled.length ? (GUESSES.find(([, re]) => filled.every((c) => re.test(c)))?.[0] ?? "string") : "string";
    return {
      name, type, examples: [...new Set(filled)].slice(0, 3),
      emptyPct: cells.length ? Math.round(((cells.length - filled.length) / cells.length) * 1000) / 10 : 0,
    };
  });
}
