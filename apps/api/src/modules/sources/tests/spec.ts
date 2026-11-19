// A source spec for the tests: KSEI ACT as a file inbox (docs/recon/ksei-sample-data.md), 14 text columns, no header,
// matched by SID. A function, so a test can change its copy.
export const ksei = () => ({
  fields: Array.from({ length: 14 }, (_, i) => ({
    name: i === 12 ? "sid" : i === 2 ? "sre" : `col_${String(i + 1).padStart(2, "0")}`,
    type: "string" as const, nullable: i !== 12, trim: true,
  })),
  mapping: {
    business_date: { cel: "file_date" },
    account_ref: { field: "sid" },
    attrs: { sre: { field: "sre" } },
  },
  derive: {},
  key_fields: ["sid"],
  mutable: false,
  calendar: "id-default",
  input: {
    kind: "file_inbox" as const,
    path: "/inbox/ksei",
    pattern: "act*.txt",
    completion: { kind: "stable_seconds" as const, seconds: 60 },
    format: { kind: "delimited" as const, delimiter: "|", header: false, encoding: "utf-8" as const },
  },
});
