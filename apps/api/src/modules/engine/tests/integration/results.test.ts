// GET /v1/spaces/:spaceId/recons/:configId/results, …/results/counts and …/results/:rowId/members (Operation result):
// one row per live match group or item no live group holds, in a business-date range; the overall status (the spec's
// table, resultStatus), each side's state, the recon's columns; any role of the space reads under row level security.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ResultCountsDto, ResultMembersDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { approvalRequests } from "../../../approvals";
import { actionRuns, postingGroupItems, postingGroups } from "../../../integrations";
import { reconResultColumns } from "../../../recon";
import { sourceShares } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { matchGroups, matchMembers, reconItems, reconRuns } from "../../schema";
import { D, D1, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

let A: string, B: string, CFG: string, VER: string, RUN: string;
let t: Record<"op" | "mk" | "out", string>;
/** Item ids by their record's reference. */
type Ref = "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7" | "P8" | "P9" | "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7";
let I: Record<Ref, string>;
/** Group ids: auto pair, force 1:3, manual with mixed currencies on B, reversed. */
let G: Record<"auto" | "force" | "mixed" | "reversed", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: B, code: "ops", name: "Ops" }]);
  await db.insert(spaceMembers).values([
    { spaceId: A, userId: await idOf("viewer"), role: "operator" }, { spaceId: A, userId: await idOf("twofa"), role: "config_maker" },
    { spaceId: B, userId: await idOf("apple"), role: "operator" },
  ]);
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  const r = await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
  CFG = r.configId; VER = r.versionId;
  RUN = Bun.randomUUIDv7();
  const SIM = Bun.randomUUIDv7();
  await db.insert(reconRuns).values([
    { id: RUN, spaceId: A, configId: CFG, configVersionId: VER, mode: "manual", dateFrom: D, dateTo: D, status: "succeeded" },
    { id: SIM, spaceId: A, configId: CFG, configVersionId: VER, mode: "simulation", dateFrom: D, dateTo: D, status: "succeeded" },
  ]);
  const ra = await put(sa, [
    { ref: "P1", amount: 10_000n }, { ref: "P2", amount: 30_000n }, { ref: "P3", amount: 500n }, { ref: "P4", amount: 700n },
    { ref: "P5", amount: 10_500n }, { ref: "P6", amount: 900n }, { ref: "P7", amount: 100n }, { ref: "P8", amount: 100n }, { ref: "P9", amount: 100n, date: D1 },
  ]);
  const rb = await put(sb, [
    { ref: "Q1", amount: 10_000n }, { ref: "Q2", amount: 10_000n, sref: "S1" }, { ref: "Q3", amount: 10_000n, sref: "S2" }, { ref: "Q4", amount: 10_000n, sref: "S3" },
    { ref: "Q5", amount: 10_000n }, { ref: "Q6", amount: 500n, ccy: "EUR" }, { ref: "Q7", amount: 100n },
  ]);
  const refs: Ref[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"];
  const recIds = [...ra, ...rb];
  I = Object.fromEntries(refs.map((k) => [k, Bun.randomUUIDv7()])) as Record<Ref, string>;
  const item = (k: Ref, over: Partial<typeof reconItems.$inferInsert> = {}) => ({
    id: I[k]!, spaceId: A, configId: CFG, recordId: recIds[refs.indexOf(k)]!, side: k.startsWith("P") ? "a" : "b", status: "matched", businessDate: k === "P9" ? D1 : D, ...over,
  });
  await db.insert(reconItems).values([
    item("P1"), item("Q1"), item("P2", { resolution: "FORCE_MATCHED", breakReason: "Amount differs", breakState: "resolved" }), item("Q2"), item("Q3"), item("Q4"),
    item("P5", { resolution: "MATCHED_MANUAL", breakReason: "No counterpart", breakState: "resolved" }), item("Q5"), item("Q6"),
    item("P3", { status: "break", breakReason: "No counterpart" }),
    item("P4", { status: "closed", resolution: "POSTED", breakReason: "No counterpart", breakState: "resolved" }),
    item("P6", { status: "closed", resolution: "POSTED", breakReason: "No counterpart", breakState: "resolved" }),
    item("P7", { status: "break", breakReason: "No counterpart" }), item("Q7", { status: "open" }),
    item("P8", { status: "matched", simRunId: SIM }), item("P9", { status: "open" }),
  ]);
  G = { auto: Bun.randomUUIDv7(), force: Bun.randomUUIDv7(), mixed: Bun.randomUUIDv7(), reversed: Bun.randomUUIDv7() };
  const group = (id: string, kind: string, over: Partial<typeof matchGroups.$inferInsert> = {}) => ({ id, spaceId: A, configId: CFG, configVersionId: VER, runId: null, passNo: kind === "auto" ? 1 : 0, kind, businessDate: D, evidence: {}, ...over });
  const simGroup = Bun.randomUUIDv7();
  await db.insert(matchGroups).values([
    group(G.auto, "auto", { runId: RUN }), group(G.force, "force"), group(G.mixed, "manual", { evidence: { note: "Paid in two" } }),
    group(G.reversed, "auto", { runId: RUN, reversedBy: RUN, reversedAt: new Date() }), group(simGroup, "auto", { simRunId: SIM, runId: SIM }),
  ]);
  const member = (groupId: string, k: Ref) => ({ groupId, spaceId: A, itemId: I[k]!, side: k.startsWith("P") ? "a" : "b" });
  await db.insert(matchMembers).values([
    member(G.auto, "P1"), member(G.auto, "Q1"), member(G.force, "P2"), member(G.force, "Q2"), member(G.force, "Q3"), member(G.force, "Q4"),
    member(G.mixed, "P5"), member(G.mixed, "Q5"), member(G.mixed, "Q6"), member(G.reversed, "P7"), member(G.reversed, "Q7"), member(simGroup, "P8"),
  ]);
  // P4 posted, its grouped posting still in an open group; P6 posted, its posting run failed (each its latest request's)
  const pg = Bun.randomUUIDv7(), rq4 = await request(I.P4!), rq6 = await request(I.P6!);
  await db.insert(postingGroups).values({ id: pg, spaceId: A, configId: CFG, configVersionId: VER, change: "posting", actionIndex: 0, variantIndex: 0, actionName: "Post", variantName: "Daily", keys: [], keyText: "", currency: "IDR", period: D, at: "day_close" });
  await db.insert(postingGroupItems).values({ groupId: pg, spaceId: A, requestId: rq4, actionIndex: 0, itemId: I.P4!, ref: "P4", amountMinor: 700n });
  await db.insert(actionRuns).values({ id: Bun.randomUUIDv7(), spaceId: A, requestId: rq6, configVersionId: VER, actionIndex: 0, actionName: "Post", kind: "posting", event: "approved", itemId: I.P6!, subjectRef: "P6", seq: 0, status: "failed", bankReference: "BR-6" });
  t = { op: await signIn("viewer"), mk: await signIn("twofa"), out: await signIn("apple") };
});

/** An approval request of the recon on `itemId` (and `itemIds`), approved unless `over` says otherwise; its id. */
async function request(itemId: string, over: Partial<typeof approvalRequests.$inferInsert> = {}) {
  const id = Bun.randomUUIDv7();
  await db.insert(approvalRequests).values({ id, spaceId: A, configId: CFG, kind: "posting", itemId, label: "Post", note: "n", status: "approved", configVersionId: VER, ...over });
  return id;
}
/** A posting run of request `requestId` (`itemId` null = one for the whole request). */
const postingRun = (requestId: string, itemId: string | null, status: string, over: Partial<typeof actionRuns.$inferInsert> = {}) =>
  db.insert(actionRuns).values({ id: Bun.randomUUIDv7(), spaceId: A, requestId, configVersionId: VER, actionIndex: 0, actionName: "Post", kind: "posting", event: "approved", itemId, seq: 1, status, ...over });

const base = (s = A, cfg = CFG) => `/v1/spaces/${s}/recons/${cfg}/results`;
const page = (qs = "", token = t.op) => json<Page<ResultRowDto>>(call("GET", `${base()}?dateFrom=${D}&dateTo=${D}${qs}`, { token }));
const counts = (qs = "") => json<ResultCountsDto>(call("GET", `${base()}/counts?dateFrom=${D}&dateTo=${D}${qs}`, { token: t.op }));
const byId = (rows: ResultRowDto[], id: string) => rows.find((r) => r.id === id)!;

describe("GET results: rows", () => {
  it("one row per live group and per lone item on the dates; reversed groups and simulation rows never show", async () => {
    const p = await page("&pageSize=100");
    expect(p.total).toBe(8);
    expect(new Set(p.items.map((r) => r.id))).toEqual(new Set([G.auto, G.force, G.mixed, I.P3, I.P4, I.P6, I.P7, I.Q7]));
    expect((await page()).pageSize).toBe(15);
    // P9 is on D1: in range only when the range takes it
    expect((await json<Page<ResultRowDto>>(call("GET", `${base()}?dateFrom=${D}&dateTo=${D1}&pageSize=100`, { token: t.op }))).total).toBe(9);
  });

  it("statuses, sides, Open link and Explain per the spec's table", async () => {
    const rows = (await page("&pageSize=100")).items;
    expect(byId(rows, G.auto)).toMatchObject({ kind: "group", businessDate: D, status: "matched", a: { state: "in_group", count: 1 }, b: { state: "in_group", count: 1 }, openItemId: null, explain: { groupId: G.auto, itemId: null, runId: RUN } });
    expect(byId(rows, G.force)).toMatchObject({ status: "force_matched", a: { count: 1 }, b: { state: "in_group", count: 3 } });
    expect(byId(rows, G.mixed).status).toBe("matched_by_hand");
    expect(byId(rows, I.P3)).toMatchObject({ kind: "item", status: "unmatch", a: { state: "unmatch", count: 1 }, b: { state: "none", count: 0 }, openItemId: I.P3, explain: { groupId: null, itemId: I.P3, runId: null } });
    expect(byId(rows, I.P4).status).toBe("posting_in_progress");
    expect(byId(rows, I.P6).status).toBe("posting_failed");
    expect(byId(rows, I.P7)).toMatchObject({ status: "unmatch", openItemId: I.P7 });
    expect(byId(rows, I.Q7)).toMatchObject({ status: "waiting_counterpart", a: { state: "none" }, b: { state: "open", count: 1 }, openItemId: null });
  });

  it("cells: a side's amounts summed, Mixed over currencies, N values for a field that differs, missing for a field the source lacks", async () => {
    let rows = (await page("&pageSize=100")).items;
    expect(byId(rows, G.force).cells).toMatchObject({ "a:amount_minor": { value: "30000", many: null }, "b:amount_minor": { value: "30000", many: null, currency: "IDR" }, "a:ext_ref": { value: "P2" }, "b:ext_ref": { value: null, many: 3 } });
    expect(byId(rows, G.mixed).cells["b:amount_minor"]).toEqual({ value: "Mixed", many: null, currency: null });
    expect(byId(rows, I.P3).cells["b:ext_ref"]).toEqual({ value: null, many: null });
    expect(byId(rows, I.P3).cells["recon:businessDate"]).toEqual({ value: D, many: null });
    const cols = [{ kind: "b", field: "attrs.settlement_ref", label: "Settlement" }, { kind: "recon", field: "resolutionNote", label: "Note" }, { kind: "recon", field: "bankReference", label: "Bank" }, { kind: "recon", field: "postingStatus", label: "Posting" }];
    expect((await call("PUT", `/v1/spaces/${A}/recons/${CFG}/result-columns`, { token: t.mk, body: { columns: cols } })).status).toBe(200);
    // a field the source wrote when it was picked, gone since (a PUT refuses one the source lacks now)
    await db.update(reconResultColumns).set({ columns: [cols[0], { kind: "a", field: "attrs.gone", label: "Gone" }, ...cols.slice(1)] });
    rows = (await page("&pageSize=100")).items;
    expect(Object.keys(byId(rows, G.force).cells).sort()).toEqual(["a:attrs.gone", "b:attrs.settlement_ref", "recon:bankReference", "recon:postingStatus", "recon:resolutionNote"]);
    expect(byId(rows, G.force).cells["b:attrs.settlement_ref"]).toEqual({ value: null, many: 3 });
    expect(byId(rows, G.force).cells["a:attrs.gone"]).toEqual({ value: null, many: null, missing: true });
    expect(byId(rows, G.mixed).cells["recon:resolutionNote"]).toEqual({ value: "Paid in two", many: null });
    expect(byId(rows, I.P6).cells["recon:bankReference"]).toEqual({ value: "BR-6", many: null });
    expect(byId(rows, I.P4).cells["recon:postingStatus"]).toEqual({ value: "grouped", many: null });
  });
});

describe("GET results: group cells", () => {
  it("a record without a currency is not a second currency (no Mixed)", async () => {
    await db.update(records).set({ currency: null }).where(eq(records.extRef, "Q3"));
    expect(byId((await page("&pageSize=100")).items, G.force).cells["b:amount_minor"]).toEqual({ value: "30000", many: null, currency: "IDR" });
  });

  it("posting status, bank reference and resolved at: the value when the row's items agree, else N values", async () => {
    const cols = [{ kind: "recon", field: "postingStatus", label: "Posting" }, { kind: "recon", field: "bankReference", label: "Bank" }, { kind: "recon", field: "resolvedAt", label: "Resolved" }];
    expect((await call("PUT", `/v1/spaces/${A}/recons/${CFG}/result-columns`, { token: t.mk, body: { columns: cols } })).status).toBe(200);
    await postingRun(await request(I.P2!), I.P2!, "posted", { bankReference: "BR-2" });
    await postingRun(await request(I.Q2!), I.Q2!, "posted", { bankReference: "BR-2" });
    const at = new Date("2026-11-02T03:00:00Z");
    await db.update(reconItems).set({ breakState: "resolved", stateAt: at }).where(eq(reconItems.id, I.P2!));
    await db.update(reconItems).set({ breakState: "resolved", stateAt: at }).where(eq(reconItems.id, I.Q2!));
    let cells = byId((await page("&pageSize=100")).items, G.force).cells;
    expect([cells["recon:postingStatus"], cells["recon:bankReference"], cells["recon:resolvedAt"]]).toEqual([{ value: "posted", many: null }, { value: "BR-2", many: null }, { value: at.toISOString(), many: null }]);
    await postingRun(await request(I.Q3!), I.Q3!, "failed", { bankReference: "BR-3" });
    await db.update(reconItems).set({ breakState: "resolved", stateAt: new Date("2026-11-02T04:00:00Z") }).where(eq(reconItems.id, I.Q3!));
    cells = byId((await page("&pageSize=100")).items, G.force).cells;
    expect([cells["recon:postingStatus"], cells["recon:bankReference"], cells["recon:resolvedAt"]]).toEqual([{ value: null, many: 2 }, { value: null, many: 2 }, { value: null, many: 2 }]);
  });
});

describe("GET results: posting runs as the Unmatch item page reads them", () => {
  it("a posting run made once per request counts for each item of the request: failed reads Posting failed, queued Posting in progress", async () => {
    const rq = await request(I.P3!, { itemIds: [I.P7!] });
    await postingRun(rq, null, "failed", { bankReference: "BR-R" });
    let rows = (await page("&pageSize=100")).items;
    expect([byId(rows, I.P3).status, byId(rows, I.P7).status]).toEqual(["posting_failed", "posting_failed"]);
    expect((await page("&result=posting_failed&pageSize=100")).items.map((r) => r.id)).toEqual(expect.arrayContaining([I.P3, I.P7]));
    await db.update(actionRuns).set({ status: "queued" }).where(eq(actionRuns.requestId, rq));
    rows = (await page("&pageSize=100")).items;
    expect([byId(rows, I.P3).status, byId(rows, I.P7).status]).toEqual(["posting_in_progress", "posting_in_progress"]);
    expect((await counts()).counts.posting_in_progress).toBe(3);
  });

  it("only the posting runs of the item's latest request count: an older request's failed posting under a later write-off reads Written off", async () => {
    const first = await request(I.P3!, { requestedAt: new Date(Date.now() - 60_000) });
    await postingRun(first, I.P3!, "failed");
    await request(I.P3!, { kind: "write_off" });
    await db.update(reconItems).set({ status: "closed", resolution: "WRITTEN_OFF", breakState: "resolved" }).where(eq(reconItems.id, I.P3!));
    expect(byId((await page("&pageSize=100")).items, I.P3).status).toBe("written_off");
    expect((await page("&result=written_off")).items.map((r) => r.id)).toEqual([I.P3]);
  });
});

describe("GET results: filters, sort, counts", () => {
  it("the SQL status (filter) agrees with resultStatus (each row's status) for every row", async () => {
    const rows = (await page("&pageSize=100")).items;
    for (const r of rows) expect((await page(`&result=${r.status}&pageSize=100`)).items.map((x) => x.id)).toContain(r.id);
    const c = await counts();
    expect(c).toMatchObject({ counts: { matched: 1, force_matched: 1, matched_by_hand: 1, unmatch: 2, posting_in_progress: 1, posting_failed: 1, waiting_counterpart: 1 }, capped: false });
    expect(Object.values(c.counts).reduce((n, x) => n + x, 0)).toBe(rows.length);
  });

  it("result, sideA, sideB filter; counts leave their own filter out; q finds a reference on either side", async () => {
    expect((await page("&result=unmatch")).items.map((r) => r.id).sort()).toEqual([I.P3, I.P7].sort());
    expect((await counts("&result=unmatch")).counts).toEqual((await counts()).counts);
    expect((await counts("&sideB=none")).counts).toEqual({ unmatch: 2, posting_in_progress: 1, posting_failed: 1 });
    expect((await page("&sideA=none")).items.map((r) => r.id)).toEqual([I.Q7]);
    expect((await page("&q=q3")).items.map((r) => r.id)).toEqual([G.force]);
    expect((await page("&q=P3")).items.map((r) => r.id)).toEqual([I.P3]);
    expect((await page("&q=nothing")).total).toBe(0);
  });

  it("sorts by status (the table's order), amount A and reference", async () => {
    expect((await page("&sort=status&pageSize=100")).items.map((r) => r.status)).toEqual(["posting_failed", "posting_in_progress", "force_matched", "matched_by_hand", "matched", "unmatch", "unmatch", "waiting_counterpart"]);
    expect((await page("&sort=-amountA&pageSize=100")).items.slice(0, 2).map((r) => r.id)).toEqual([G.force, G.mixed]);
    expect((await page("&sort=ref&pageSize=100")).items[0]!.id).toBe(G.auto);
  });

  it("by default the newest business date comes first", async () => {
    const p = await json<Page<ResultRowDto>>(call("GET", `${base()}?dateFrom=${D}&dateTo=${D1}&pageSize=100`, { token: t.op }));
    expect(p.items[0]!.id).toBe(I.P9);
  });

  it("counts per side state, each leaving its own side's filter out", async () => {
    const c = await counts("&sideB=none");
    expect(c.sideB).toEqual((await counts()).sideB);
    expect(c.sideB).toEqual({ in_group: 3, open: 1, none: 4 });
    expect(c.sideA).toEqual({ unmatch: 2, closed: 2 });
  });

  it("400 on a range over 31 days, an end before the start, an unknown status (before the guard); 404 for another space or a non-UUID recon", async () => {
    for (const qs of ["?dateFrom=2026-11-01&dateTo=2026-12-02", "?dateFrom=2026-11-02&dateTo=2026-11-01", "?result=lost", "?sort=merchant"]) {
      expect((await call("GET", `${base()}${qs}`, {})).status).toBe(400);
      expect((await call("GET", `${base()}/counts${qs}`, { token: t.op })).status).toBe(400);
    }
    expect((await call("GET", `${base()}?dateFrom=2026-11-01&dateTo=2026-12-01`, { token: t.op })).status).toBe(200);
    expect((await call("GET", base(), {})).status).toBe(401);
    expect((await call("GET", base(A, CFG), { token: t.out })).status).toBe(403);
    expect((await call("GET", base(B, CFG), { token: t.out })).status).toBe(404);
    expect((await call("GET", `${base(B, CFG)}/counts`, { token: t.out })).status).toBe(404);
    expect((await call("GET", base(A, "nope"), { token: t.op })).status).toBe(404);
  });
});

describe("result columns: side fields", () => {
  it("PUT refuses a side field the side's source does not write (400, named)", async () => {
    const r = await call("PUT", `/v1/spaces/${A}/recons/${CFG}/result-columns`, { token: t.mk, body: { columns: [{ kind: "a", field: "attrs.gone", label: "Gone" }] } });
    expect(r.status).toBe(400);
    expect((await json<{ error: { message: string } }>(r)).error.message).toContain(`"Gone"`);
  });

  it("a shared source the space can no longer read leaves the default columns unmarked", async () => {
    const sb = await makeSource(B, plainSource());
    await db.insert(sourceShares).values({ spaceId: B, sourceId: sb.sourceId, toSpaceId: A });
    const sa = await makeSource(A, plainSource());
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
    await db.delete(sourceShares);
    const cols = await json<{ missing: unknown[]; isDefault: boolean }>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/result-columns`, { token: t.op }));
    expect(cols).toMatchObject({ isDefault: true, missing: [] });
  });
});

describe("GET results/:rowId/members", () => {
  it("each side's records of a group or a lone item, with the configured source fields; another recon's or a reversed group is 404", async () => {
    const m = await json<ResultMembersDto>(call("GET", `${base()}/${G.force}/members?kind=group`, { token: t.op }));
    expect(m.a.map((x) => x.ref)).toEqual(["P2"]);
    expect(m.b.map((x) => x.ref)).toEqual(["Q2", "Q3", "Q4"]);
    expect(m.b[0]).toMatchObject({ amountMinor: "10000", currency: "IDR", businessDate: D, status: "matched" });
    expect(m.more).toEqual({ a: 0, b: 0 });
    // Explain head to head: every field each side's source writes, by label, and every record's value of each
    expect(m.labels.b.map((f) => f.label)).toEqual(["Reference", "Amount", "Currency", "Business date", "Event time", "Account", "Direction", "Settlement ref", "When"]);
    expect(m.labels.a.slice(0, 2)).toEqual([{ key: "ext_ref", label: "Reference" }, { key: "amount_minor", label: "Amount" }]);
    expect(m.b[0]!.values).toMatchObject({ ext_ref: "Q2", amount_minor: "10000", currency: "IDR", business_date: D, "attrs.settlement_ref": "S1", "attrs.when": null });
    expect(m.summary).toEqual({ groupKind: "force", pass: 0, resolution: "FORCE_MATCHED", reason: { value: "Amount differs", many: null }, assignee: { value: null, many: null }, request: null, posting: null });
    const p6 = await json<ResultMembersDto>(call("GET", `${base()}/${I.P6}/members?kind=item`, { token: t.op }));
    expect(p6.summary).toMatchObject({ groupKind: null, resolution: "POSTED", request: { kind: "posting", status: "approved" }, posting: { status: { value: "failed", many: null }, bankReference: { value: "BR-6", many: null } } });
    // the signed amount the row's cell sums: a debit counts negative
    await db.update(records).set({ direction: "D" }).where(eq(records.extRef, "Q6"));
    const mixed = await json<ResultMembersDto>(call("GET", `${base()}/${G.mixed}/members?kind=group`, { token: t.op }));
    expect(mixed.b.find((x) => x.ref === "Q6")!.amountMinor).toBe("-500");
    const one = await json<ResultMembersDto>(call("GET", `${base()}/${I.P3}/members?kind=item`, { token: t.op }));
    expect([one.a.map((x) => x.ref), one.b]).toEqual([["P3"], []]);
    expect((await call("GET", `${base()}/${G.reversed}/members?kind=group`, { token: t.op })).status).toBe(404);
    expect((await call("GET", `${base()}/${I.P1}/members?kind=item`, { token: t.op })).status).toBe(404); // in a live group: its row is the group
    expect((await call("GET", `${base()}/${G.force}/members?kind=row`, { token: t.op })).status).toBe(400);
    expect((await call("GET", `${base(B, CFG)}/${G.force}/members?kind=group`, { token: t.out })).status).toBe(404);
  });
});
