// Rule passes (cardinality 1:0, owner 25 Nov: "side A amount = 0 is a match"): an item of the rule's side that meets
// every condition is matched alone, a group of one member, after the passes before it had their chance to pair it. It
// counts as matched (the run's counters, Operation result) and never reaches day close; an item that fails the rule
// stays as the other passes leave it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRunDto } from "@starterkit/shared/contracts/recon";
import type { ResultCountsDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { and, asc, eq, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records, sourceCursors } from "../../../ingest";
import { calendars } from "../../../sources";
import { spaces } from "../../../spaces";
import { matchGroups, matchMembers, reconItems, reconRuns } from "../../schema";
import { runRecon } from "../../service";
import { ccyEq, D, makeSource, plainSource, put, recon, spec, type Src } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, A: string, token: string;

const after = new Date("2026-12-01T00:00:00+07:00");
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
const rule = (no: number, side: "a" | "b", when: unknown[]) => ({ no, name: "Zero amount", cardinality: "1:0", side, when, blocking: [], predicates: [], accept: "auto", on_ambiguous: "break" });
const zero = [{ field: "amount_minor", op: "eq", value: "0" }];
const json = async <T>(r: Promise<Response>) => (await (await r).json()) as T;
const itemsOf = (configId: string) => db.select({ side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, ref: records.extRef })
  .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
  .where(and(eq(reconItems.configId, configId), sql`${reconItems.simRunId} is null`)).orderBy(asc(records.extRef), asc(reconItems.side));

async function sides(): Promise<[Src, Src]> {
  const s = [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
  for (const x of s) await db.insert(sourceCursors).values({ spaceId: x.spaceId, sourceId: x.sourceId, completeThrough: after });
  return s;
}

beforeAll(async () => {
  probe = await appRoleDb();
  await resetData();
  await db.delete(spaces);
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] }).onConflictDoNothing();
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 2));
  token = await signIn("superadmin");
}, 60_000);
beforeEach(async () => {
  await db.update(spaces).set({ status: "archived" });
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: `s${A.slice(-8)}`, name: "Treasury" });
});
afterAll(async () => {
  await probe.$client.close();
});

describe("a rule pass (1:0)", () => {
  it("matches side A's zero amounts alone, after the pair pass took the one that has a counterpart; the rest is unmatch at the run's end", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact, rule(2, "a", zero)]));
    await put(sa, [{ ref: "A1", amount: 100n }, { ref: "Z1", amount: 0n }, { ref: "Z2", amount: 0n }, { ref: "A2", amount: 100n }]);
    await put(sb, [{ ref: "A1", amount: 100n }, { ref: "Z2", amount: 0n }, { ref: "B0", amount: 0n }]);
    const { runId } = (await runRecon(probe, { ...r, mode: "daily", from: D }))!;

    expect(await itemsOf(r.configId)).toEqual([
      { side: "a", status: "matched", reason: null, ref: "A1" }, { side: "b", status: "matched", reason: null, ref: "A1" },
      { side: "a", status: "break", reason: "No counterpart", ref: "A2" },
      { side: "b", status: "break", reason: "No counterpart", ref: "B0" }, // a zero on side B: the rule reads side A only
      { side: "a", status: "matched", reason: null, ref: "Z1" },
      { side: "a", status: "matched", reason: null, ref: "Z2" }, { side: "b", status: "matched", reason: null, ref: "Z2" },
    ]);
    // Z1's group: the rule's pass, automatic, one member on side A, its evidence naming the rule and its condition
    const groups = await db.select({ id: matchGroups.id, pass: matchGroups.passNo, kind: matchGroups.kind, evidence: matchGroups.evidence }).from(matchGroups)
      .where(and(eq(matchGroups.configId, r.configId), eq(matchGroups.passNo, 2)));
    expect(groups.map((g) => [g.pass, g.kind])).toEqual([[2, "auto"]]);
    expect(groups[0]!.evidence).toMatchObject({ pass: 2, name: "Zero amount", chosen: "rule met, no counterpart", side: "a", predicates: [],
      rule: [{ op: "eq", field: "amount_minor", value: "0", passed: true }] });
    const members = await db.select({ side: matchMembers.side, amount: matchMembers.signedAmount }).from(matchMembers).where(eq(matchMembers.groupId, groups[0]!.id));
    expect(members).toEqual([{ side: "a", amount: 0n }]);
    // the run counts it as matched, on side A only
    const [run] = await db.select({ counters: reconRuns.counters }).from(reconRuns).where(eq(reconRuns.id, runId));
    expect((run!.counters as ReconRunDto["counters"]).passes["2"]).toMatchObject({ matched: 1, matchedItems: { a: 1, b: 0 }, broken: 0 });
    expect((run!.counters as ReconRunDto["counters"]).passes["1"]).toMatchObject({ matched: 2, matchedItems: { a: 2, b: 2 } });

    // what is left is unmatch since the run's end (DEC-064); the rule's match stays
    expect((await itemsOf(r.configId)).map((x) => `${x.ref} ${x.side} ${x.status} ${x.reason ?? ""}`.trim())).toEqual([
      "A1 a matched", "A1 b matched", "A2 a break No counterpart", "B0 b break No counterpart", "Z1 a matched", "Z2 a matched", "Z2 b matched",
    ]);

    // Operation result: the rule's group is a matched row, its side A in the group, side B none
    const counts = await json<ResultCountsDto>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/results/counts?dateFrom=${D}&dateTo=${D}`, { token }));
    expect(counts.counts).toEqual({ matched: 3, unmatch: 2 });
    const rows = await json<Page<ResultRowDto>>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/results?dateFrom=${D}&dateTo=${D}&result=matched&pageSize=15`, { token }));
    expect(rows.items.filter((x) => x.b.count === 0).map((x) => [x.status, x.a.state, x.a.count, x.b.state])).toEqual([["matched", "in_group", 1, "none"]]);
  });

  it("a rule on side B with several conditions (in, not_null); an item failing one is unmatch; a run again adds nothing", async () => {
    const [sa, sb] = await sides();
    const fee = [{ field: "attrs.settlement_ref", op: "in", values: ["FEE", "ADJ"] }, { field: "account_ref", op: "not_null" }];
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact, rule(2, "b", fee)]));
    await put(sb, [{ ref: "F1", amount: 5n, sref: "FEE", acct: "001" }, { ref: "F2", amount: 5n, sref: "ADJ" }, { ref: "F3", amount: 5n, sref: "OTHER", acct: "001" }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect((await itemsOf(r.configId)).map((x) => `${x.ref} ${x.status}`)).toEqual(["F1 matched", "F2 break", "F3 break"]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await db.select({ id: matchGroups.id }).from(matchGroups).where(eq(matchGroups.configId, r.configId))).toHaveLength(1);
  });
});
