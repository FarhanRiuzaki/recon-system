// Fixtures of the engine's integration tests: sources and recons written straight to the tables, recon_source_test's
// source1 / source2 and the Plan 3 gate config (plan "Config gerbang"), a plain file source and its records.
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { encryptSecret } from "../../../kernel/crypto";
import { db } from "../../../kernel/db";
import { specHash } from "../../../kernel/versions";
import { records } from "../../ingest";
import { reconConfigs, reconConfigVersions } from "../../recon";
import { sourceConnections, sources, sourceVersions } from "../../sources";

/** The maker of the fixtures' versions (no user row). */
export const U = Bun.randomUUIDv7();

export const ref = (k: number) => `TSTREF${String(k).padStart(6, "0")}`;
export const range = (a: number, b: number, skip: number[] = []) => Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((k) => !skip.includes(k)).map(ref);

/** A source of `spaceId` with version 1 published (a connection to `<test>_src` for a database source). */
export async function makeSource(spaceId: string, spec: SourceSpec, secret?: object) {
  const sourceId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  await db.insert(sources).values({ id: sourceId, spaceId, code: `s-${sourceId.slice(-12)}`, name: "S", kind: spec.input.kind });
  await db.insert(sourceVersions).values({ id: versionId, spaceId, sourceId, version: 1, status: "published", spec, specHash: "h", makerId: U, publishedAt: new Date() });
  if (spec.input.kind !== "file_inbox") {
    await db.insert(sourceConnections).values({ spaceId, sourceId, engine: "postgres", secretEnc: encryptSecret(JSON.stringify(secret)), options: { tls: false, connectTimeoutSeconds: 5 } });
  }
  return { spaceId, sourceId, versionId };
}
export type Src = Awaited<ReturnType<typeof makeSource>>;

/** A recon of `spaceId` with version 1 of `spec` published (status `status`). */
export async function recon(spaceId: string, spec: unknown, status = "published") {
  const configId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: configId, spaceId, code: `r-${configId.slice(-12)}`, name: "R" });
  await db.insert(reconConfigVersions).values({ id: versionId, configId, spaceId, version: 1, status, spec, specHash: specHash(spec as object), matchingHash: specHash(spec as object), makerId: U });
  return { spaceId, configId, versionId };
}

// ------------------------------------------------------------------------------------------------ the gate
/** recon_source_test's source1 / source2 (docs/recon/source-test-db.md) pulled by watermark, with the gate mapping. */
export const gateSource = (n: 1 | 2): SourceSpec => {
  const [ref, date, amount, ccy, acct] = n === 1 ? ["txn_ref", "business_date", "amount_minor", "ccy", "account_no"] : ["reference", "value_date", "amount", "currency", "acct"];
  return {
    fields: [
      { name: ref, type: "string", nullable: false, trim: true }, { name: date, type: "date", nullable: false, trim: true },
      { name: amount, type: "integer", nullable: false, trim: true }, { name: ccy, type: "string", nullable: false, trim: true },
      { name: acct, type: "string", nullable: false, trim: true },
    ],
    mapping: {
      ext_ref: { field: ref }, business_date: { field: date }, amount_minor: { field: amount, unit: "minor" }, currency: { field: ccy }, account_ref: { field: acct }, attrs: {},
    },
    derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_watermark", table: `core.source${n}`, watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 0, chunk: 500 },
  } as SourceSpec;
};
export const ccyEq = { op: "eq", field: "currency" };
/** The gate config (plan "Config gerbang"). */
export const gateSpec = (a: string, b: string) => ({
  sides: [{ key: "a", label: "Source 1", source_id: a, filter: [] }, { key: "b", label: "Source 2", source_id: b, filter: [] }],
  passes: [
    { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break",
      predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, { op: "eq", field: "business_date" }, ccyEq] },
    { no: 2, name: "Amount tolerance", cardinality: "1:1", blocking: ["ext_ref", "business_date"], accept: "suggest", on_ambiguous: "suggest",
      predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccyEq] },
    { no: 3, name: "Date window", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
      predicates: [{ op: "eq", field: "amount_minor" }, { op: "date_window", field: "business_date", days: 1 }, ccyEq] },
  ],
  carry_over_days: 1, schedule: { business_date_offset: 0, from: "00:00", to: "23:59", every_minutes: 60 },
});

/** A file source (never pulled: its records are written by the test) with core fields and attrs.settlement_ref. */
export const plainSource = (): SourceSpec => ({
  fields: [
    { name: "ref", type: "string", nullable: false, trim: true }, { name: "amount", type: "integer", nullable: true, trim: true },
    { name: "date", type: "date", nullable: false, trim: true }, { name: "ccy", type: "string", nullable: true, trim: true },
    { name: "acct", type: "string", nullable: true, trim: true }, { name: "sref", type: "string", nullable: true, trim: true },
    { name: "dir", type: "string", nullable: true, trim: true }, { name: "et", type: "datetime", nullable: true, trim: true },
    { name: "when", type: "date", nullable: true, trim: true },
  ],
  mapping: {
    ext_ref: { field: "ref" }, amount_minor: { field: "amount", unit: "minor" }, business_date: { field: "date" }, currency: { field: "ccy" },
    account_ref: { field: "acct" }, direction: { field: "dir" }, event_time: { field: "et" }, attrs: { settlement_ref: { field: "sref" }, when: { field: "when" } },
  },
  derive: {}, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/inbox/x", pattern: "*.csv", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: ",", quote: '"', header: true, encoding: "utf-8" } },
} as SourceSpec);
export type Rec = { ref?: string; amount?: bigint; ccy?: string; date?: string; acct?: string; sref?: string; et?: string; dir?: string; attrs?: Record<string, string> };
/** Writes records of `s` (as ingest would have: current, no snapshot); answers their ids in order. */
export async function put(s: Src, rows: Rec[]): Promise<string[]> {
  const vals = rows.map((r) => ({
    id: Bun.randomUUIDv7(), spaceId: s.spaceId, sourceId: s.sourceId, sourceVersionId: s.versionId, businessDate: r.date ?? D, bdayIndex: 0,
    extRef: r.ref ?? null, accountRef: r.acct ?? null, amountMinor: r.amount ?? null, currency: r.ccy ?? "IDR", direction: r.dir ?? null,
    eventTime: r.et ? new Date(r.et) : null, attrs: { ...(r.sref ? { settlement_ref: r.sref } : {}), ...r.attrs }, rowHash: Bun.randomUUIDv7(), originId: Bun.randomUUIDv7(),
  }));
  await db.insert(records).values(vals);
  return vals.map((v) => v.id);
}
export const D = "2026-11-02", D1 = "2026-11-03";
export const spec = (a: string, b: string, passes: unknown[], carry = 1) => ({ ...gateSpec(a, b), passes, carry_over_days: carry });
