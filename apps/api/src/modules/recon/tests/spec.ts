// Fixtures for the recon tests: the source specs of recon_source_test's source1 and source2 (docs/recon/source-test-db.md,
// as a file inbox here) and the Plan 3 gate config over them. Functions, so a test can change its copy.

/** source1 (txn_ref, amount, value_date, ccy, account_no) or source2 (reference, amount, value_date, currency, acct). */
export const sourceSpec = (n: 1 | 2 = 1) => {
  const [ref, ccy, acct] = n === 1 ? ["txn_ref", "ccy", "account_no"] : ["reference", "currency", "acct"];
  return {
    fields: [
      { name: ref, type: "string" as const, nullable: false, trim: true },
      { name: "amount", type: "decimal" as const, nullable: false, trim: true, format: { scale: 2 } },
      { name: "value_date", type: "date" as const, nullable: false, trim: true, format: { date: "yyyy-MM-dd" } },
      { name: ccy, type: "string" as const, nullable: false, trim: true },
      { name: acct, type: "string" as const, nullable: true, trim: true },
      { name: "settlement_ref", type: "string" as const, nullable: true, trim: true },
    ],
    mapping: {
      ext_ref: { field: ref },
      amount_minor: { field: "amount", unit: "major" as const },
      business_date: { field: "value_date" },
      currency: { field: ccy },
      account_ref: { field: acct },
      attrs: { settlement_ref: { field: "settlement_ref" } },
    },
    derive: {},
    key_fields: [ref],
    mutable: false,
    calendar: "id-default",
    input: {
      kind: "file_inbox" as const,
      path: `/inbox/source${n}`,
      pattern: "*.csv",
      completion: { kind: "stable_seconds" as const, seconds: 60 },
      format: { kind: "delimited" as const, delimiter: ",", quote: '"', header: true, encoding: "utf-8" as const },
    },
  };
};

const ccyEq = { op: "eq" as const, field: "currency" };
/** The Plan 3 gate config (plan "Config gerbang"): three passes, each with currency eq; carry over 1 day, daily. */
export const gate = (a: string, b: string) => ({
  sides: [
    { key: "a" as const, label: "Source 1", source_id: a, filter: [] as unknown[] },
    { key: "b" as const, label: "Source 2", source_id: b, filter: [] as unknown[] },
  ] as [{ key: "a"; label: string; source_id: string; filter: unknown[] }, { key: "b"; label: string; source_id: string; filter: unknown[] }],
  passes: [
    {
      no: 1, name: "Exact", cardinality: "1:1" as const, blocking: [] as (string | { a: string; b: string })[], accept: "auto" as const, on_ambiguous: "break" as const,
      predicates: [{ op: "eq" as const, field: "ext_ref" }, { op: "eq" as const, field: "amount_minor" }, { op: "eq" as const, field: "business_date" }, ccyEq],
    },
    {
      no: 2, name: "Amount tolerance", cardinality: "1:1" as const, blocking: ["ext_ref", "business_date"] as (string | { a: string; b: string })[], accept: "suggest" as const, on_ambiguous: "suggest" as const,
      predicates: [{ op: "amount_abs_tol" as const, field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccyEq],
    },
    {
      no: 3, name: "Date window", cardinality: "1:1" as const, blocking: ["ext_ref"] as (string | { a: string; b: string })[], accept: "suggest" as const, on_ambiguous: "suggest" as const,
      predicates: [{ op: "eq" as const, field: "amount_minor" }, { op: "date_window" as const, field: "business_date", days: 1 }, ccyEq],
    },
  ],
  grace_minutes: 30,
  carry_over_days: 1,
  close_at: "23:00",
  schedule: { kind: "daily" as const, at: "23:30", business_date_offset: 0 },
});
