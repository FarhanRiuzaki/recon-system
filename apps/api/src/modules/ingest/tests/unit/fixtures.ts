// The KSEI fixture of docs/recon/ksei-sample-data.md (day D, act20261102.txt): 10 valid lines, a 13-column line and a
// line with an empty sid (col_13). SNN = TSTSID0000000NN.
import type { SourceSpec } from "@starterkit/shared/contracts/sources";

const row = (n: number, sid = `TSTSID0000000${String(n).padStart(2, "0")}`) =>
  ["A1", "B1", `TSTSRE${String(n).padStart(3, "0")}`, "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11", "L12", sid, "N14"].join("|");

const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => row(n));
lines.push(row(11).split("|").slice(0, 13).join("|")); // 13 columns
lines.push(row(12, "")); // sid empty
export const KSEI_FILE = lines.join("\n") + "\n";

/** The KSEI ACT spec (as sources/tests/spec.ts): 14 text columns, no header, sid required, business_date from the file name. */
export const ksei = (): SourceSpec => ({
  fields: Array.from({ length: 14 }, (_, i) => ({
    name: i === 12 ? "sid" : i === 2 ? "sre" : `col_${String(i + 1).padStart(2, "0")}`,
    type: "string" as const, nullable: i !== 12, trim: true,
  })),
  mapping: { business_date: { cel: "file_date" }, account_ref: { field: "sid" }, attrs: { sre: { field: "sre" } } },
  derive: {},
  key_fields: ["sid"],
  mutable: false,
  calendar: "id-default",
  input: {
    kind: "file_inbox", path: "/inbox/ksei", pattern: "act*.txt", completion: { kind: "stable_seconds", seconds: 60 },
    format: { kind: "delimited", delimiter: "|", quote: null, header: false, encoding: "utf-8" },
  },
});

/** The calendar every install has: Saturday and Sunday off. */
export const idDefault = { weekend: [6, 7], holidays: [] as string[] };
