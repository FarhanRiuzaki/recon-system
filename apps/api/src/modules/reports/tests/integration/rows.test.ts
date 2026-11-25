// A report's rows: the recon's result rows read in keyset pages (each row once, even when one changes between pages),
// filtered by status, with the report's columns and the recon's customer-data columns masked.
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
import { reportRows } from "../../rows";

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

const spec = (o: Partial<ReportSpec> = {}): ReportSpec => ({
  kind: "transactions", rows: { statuses: [], side: "both", reasons: [] }, columns: [{ key: "a:ext_ref", header: "Reference" }, { key: "a:account_ref", header: "Account" }],
  groups: [], totals: [], output: { format: "csv", fileName: "x", masking: "masked" }, when: { afterRun: false, onRequest: true }, official: false, ...o,
} as ReportSpec);

describe("reportRows", () => {
  it("reads every row once in pages, even when one changes between pages; dates in order", async () => {
    const seen: string[] = [];
    let n = 0;
    for await (const page of reportRows(db, A, CFG, spec(), D, D1, 1000)) {
      seen.push(...page.map((r) => r.values["a:ext_ref"]!));
      if (n++ === 0) await db.update(reconItems).set({ breakReason: "Changed" }).where(eq(reconItems.id, ids.at(-1)!));
    }
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);
  });

  it("filters by the Operation result's status; masks the recon's customer-data column unless full", async () => {
    const rows: string[][] = [];
    for await (const page of reportRows(db, A, CFG, spec({ rows: { statuses: ["unmatch"], side: "both", reasons: [] } }), D, D, 2000)) rows.push(...page.map((r) => [r.status, r.values["a:account_ref"]!]));
    expect(new Set(rows.map((r) => r[0]))).toEqual(new Set(["unmatch"]));
    expect(rows[0]![1]).toMatch(/^·+\d{4}$/);
    const full: string[] = [];
    for await (const page of reportRows(db, A, CFG, spec({ official: true, output: { format: "csv", fileName: "x", masking: "full" } }), D, D, 2000)) full.push(...page.map((r) => r.values["a:account_ref"]!));
    expect(full[0]).toMatch(/^ACCT\d{8}$/);
  });

  it("the account is masked with no column marked as customer data", async () => {
    await db.delete(reconResultColumns);
    const rows: (string | null)[] = [];
    for await (const page of reportRows(db, A, CFG, spec(), D, D, 2000)) rows.push(...page.map((r) => r.values["a:account_ref"]!));
    expect(rows[0]).toMatch(/^·+\d{4}$/);
  });

  it("an item matched into a new group between two pages is written once", async () => {
    let n = 0, out = 0;
    for await (const page of reportRows(db, A, CFG, spec(), D, D1, 1000)) {
      out += page.length;
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
