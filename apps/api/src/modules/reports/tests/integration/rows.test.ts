// A report's data: the recon's results, items or recap, read in keyset pages (each row once, even when one changes
// between pages), filtered by the design, with the recon's customer-data fields named for masking.
import { beforeEach, describe, expect, it } from "bun:test";
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { eq } from "drizzle-orm";
import { resetData } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { matchGroups, matchMembers, reconItems } from "../../../engine";
import { D, D1, makeSource, plainSource, put, recon, spec as reconSpec } from "../fixtures";
import { records } from "../../../ingest";
import { reconResultColumns } from "../../../recon";
import { spaces } from "../../../spaces";
import { columnFor, emptySpec, fromV1 } from "@starterkit/shared/report-spec";
import { datasetRows } from "../../rows";
import type { DataRow } from "../../cells";

let A: string, CFG: string, VER: string, ids: string[];
const N = 2500;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  ({ configId: CFG, versionId: VER } = await recon(A, reconSpec(sa.sourceId, sb.sourceId, [])));
  const recs = await put(sa, Array.from({ length: N }, (_, i) => ({ ref: `R${i}`, amount: 100n, acct: `ACCT${String(i).padStart(8, "0")}`, date: i % 2 ? D1 : D })));
  ids = recs.map(() => Bun.randomUUIDv7());
  await db.insert(reconItems).values(recs.map((recordId, i) => ({
    id: ids[i]!, spaceId: A, configId: CFG, recordId, side: "a", status: i % 5 ? "break" : "open", businessDate: i % 2 ? D1 : D, breakReason: i % 5 ? "No counterpart" : null,
  })));
  await db.insert(reconResultColumns).values({ spaceId: A, configId: CFG, columns: [{ kind: "a", field: "account_ref", label: "Account", customer: true }] });
});

const spec = (o: Partial<ReportSpec> = {}): ReportSpec => ({ ...emptySpec(), columns: [columnFor("c1", "a:ext_ref", "Reference"), columnFor("c2", "a:account_ref", "Account")], ...o });
async function all(s: ReportSpec, from = D, to = D, size = 2000) {
  const rows: DataRow[] = [];
  let customer = new Set<string>();
  for await (const p of datasetRows(db, A, CFG, s, from, to, size)) { rows.push(...p.rows); customer = p.customer; }
  return { rows, customer };
}

describe("datasetRows", () => {
  it("results: every row once in pages, even when one changes between pages", async () => {
    const seen: string[] = [];
    let n = 0;
    for await (const page of datasetRows(db, A, CFG, spec(), D, D1, 1000)) {
      seen.push(...page.rows.map((r) => r.values["a:ext_ref"] as string));
      if (n++ === 0) await db.update(reconItems).set({ breakReason: "Changed" }).where(eq(reconItems.id, ids.at(-1)!));
    }
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
  });

  it("filters: status pushed to the engine, contains and empty checked per row; accounts named customer data even unflagged", async () => {
    const breaks = await all(spec({ rows: { filters: [{ ref: "recon:status", op: "any_of", value: ["unmatch"] }] } }));
    expect(new Set(breaks.rows.map((r) => r.values["recon:status"]))).toEqual(new Set(["unmatch"]));
    expect(breaks.rows[0]!.values["a:account_ref"]).toMatch(/^ACCT\d{8}$/);
    expect(breaks.customer.has("a:account_ref")).toBe(true);
    const r12 = await all(spec({ rows: { filters: [{ ref: "a:ext_ref", op: "contains", value: ["r12"] }] } }));
    expect(r12.rows.every((r) => String(r.values["a:ext_ref"]).includes("R12"))).toBe(true);
    await db.delete(reconResultColumns);
    expect((await all(spec())).customer.has("a:account_ref")).toBe(true);
  });

  it("amounts in major units of their currency", async () => {
    const s = spec({ columns: [columnFor("c1", "a:amount_minor", "Amount")] });
    expect((await all(s)).rows[0]!.values["a:amount_minor"]).toBe(1);
  });

  it("items: one row per item, its fields under its side, side and item status as recon fields", async () => {
    const r = await all(spec({ dataset: "items", columns: [columnFor("c1", "a:ext_ref", "Ref"), columnFor("c2", "recon:side", "Side")] }));
    expect(r.rows.length).toBe(N / 2);
    expect(r.rows[0]!.values).toMatchObject({ "recon:side": "a", "a:ext_ref": expect.stringMatching(/^R\d+$/), "item:ext_ref": expect.stringMatching(/^R\d+$/), "recon:item_status": expect.any(String) });
  });

  it("recap: one row per date and currency with results, breaks, match rate and side totals", async () => {
    const r = await all(spec({ dataset: "recap", columns: [columnFor("c1", "recap:date", "Date")] }), D, D1);
    expect(r.rows.map((x) => x.values["recap:date"])).toEqual([D, D1]);
    const d = r.rows[0]!.values;
    expect(d["recap:results"]).toBe(N / 2);
    const unmatch = (await all(spec({ rows: { filters: [{ ref: "recon:status", op: "any_of", value: ["unmatch"] }] } }))).rows.length;
    expect(unmatch).toBeGreaterThan(0);
    expect(d["recap:breaks"]).toBe(unmatch);
    expect(d["recap:matched"]).toBe(0);
    expect(d["recap:match_rate"]).toBe(0);
    expect(d["recap:count_a"]).toBe(N / 2);
    expect(d["recap:amount_a"]).toBe(N / 2);
  });

  it("a v1 stored design reads the same rows as converted", async () => {
    const v1 = fromV1({ kind: "transactions", rows: { statuses: ["unmatch"], side: "a", reasons: [] }, columns: [{ key: "a:ext_ref", header: "Reference" }], groups: [], totals: [],
      output: { format: "csv", fileName: "x", masking: "masked" }, when: { afterRun: true, onRequest: true }, official: false });
    const r = await all(v1);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(new Set(r.rows.map((x) => x.values["recon:status"]))).toEqual(new Set(["unmatch"]));
  });

  it("an item matched into a new group between two pages is written once", async () => {
    let n = 0, out = 0;
    for await (const page of datasetRows(db, A, CFG, spec(), D, D1, 1000)) {
      out += page.rows.length;
      if (n++ === 0) {
        // the first item read becomes a group's member: the group's id sorts after every item's
        const G = Bun.randomUUIDv7();
        const [first] = await db.select().from(reconItems).where(eq(reconItems.id, ids.find((_, i) => i % 2 === 0)!));
        await db.insert(matchGroups).values({ id: G, spaceId: A, configId: CFG, configVersionId: VER, runId: null, passNo: 0, kind: "force", businessDate: first!.businessDate, evidence: {} });
        await db.insert(matchMembers).values({ groupId: G, spaceId: A, itemId: first!.id, side: "a" });
        await db.update(reconItems).set({ status: "matched" }).where(eq(reconItems.id, first!.id));
      }
    }
    expect(out).toBe(N);
  });
});
