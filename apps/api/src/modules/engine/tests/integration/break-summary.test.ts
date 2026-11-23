// GET /v1/spaces/:spaceId/breaks sorted by amount or state, its rows' counterpart side and recheck, and
// GET …/breaks/summary (audit Q1–Q3): open items, open amount per currency, past carry over, mine; with the list's
// filters; any role of the space, read under the space's row level security.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakRowDto, BreakSummaryDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import { eq, sql } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconConfigVersions } from "../../../recon";
import { reconDays, reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

let A: string, B: string, CFG: string;
let SA: Awaited<ReturnType<typeof makeSource>>;
let t: Record<"op" | "out" | "sa", string>;
/** a1 100.00 IDR (No counterpart, late match), a2 -250.00 IDR (Amount differs), a3 5.00 EUR (No counterpart): all on D, carry over 1 day. */
let I: Record<"a1" | "a2" | "a3", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: B, code: "ops", name: "Ops" }]);
  await db.insert(spaceMembers).values([{ spaceId: A, userId: await idOf("viewer"), role: "operator" }, { spaceId: B, userId: await idOf("apple"), role: "operator" }]);
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  SA = sa;
  const [r1, r2, r3] = await put(sa, [{ ref: "P1", amount: 10_000n }, { ref: "P2", amount: -25_000n }, { ref: "P3", amount: 500n, ccy: "EUR" }]);
  const r = await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
  const item = (recordId: string, reason: string, lateMatch = false) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: r.configId, recordId, side: "a", status: "break", businessDate: D, breakReason: reason, lateMatch });
  const rows = { a1: item(r1!, "No counterpart", true), a2: item(r2!, "Amount differs"), a3: item(r3!, "No counterpart") };
  await db.insert(reconItems).values(Object.values(rows));
  CFG = r.configId;
  I = { a1: rows.a1.id, a2: rows.a2.id, a3: rows.a3.id };
  t = { op: await signIn("viewer"), out: await signIn("apple"), sa: await platformAdmin() };
});

const list = async (qs: string) => (await json<Page<BreakRowDto>>(call("GET", `/v1/spaces/${A}/breaks${qs}`, { token: t.op }))).items;
const summary = (space: string, token: string, qs = "") => call("GET", `/v1/spaces/${space}/breaks/summary${qs}`, { token });

describe("GET breaks: sorts and row fields", () => {
  it("sorts by absolute amount (largest first with -amount, as the summary adds them) and by state in the queue's order", async () => {
    // ponytail: minor units across currencies compare as numbers (500 EUR cents < 10,000 IDR sen); per currency when FX lands
    expect((await list("?sort=-amount")).map((x) => x.ref)).toEqual(["P2", "P1", "P3"]);
    expect((await list("?sort=amount")).map((x) => x.ref)).toEqual(["P3", "P1", "P2"]);
    await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a2] } });
    expect((await list("?sort=-state")).map((x) => x.ref)[0]).toBe("P2"); // assigned comes after new
    expect((await call("GET", `/v1/spaces/${A}/breaks?sort=reason`, { token: t.op })).status).toBe(400);
  });

  it("each row names the counterpart's side and whether runs check it again", async () => {
    const r = await list("?sort=amount");
    expect(r.map((x) => x.counterpartSide)).toEqual(["Source 2", "Source 2", "Source 2"]);
    // carry over 1 day: a late-match "No counterpart" break is checked until D + 1; the others are not checked again
    expect(r.find((x) => x.id === I.a1)!.recheck).toEqual({ kind: "until", date: "2026-11-03" });
    expect(r.find((x) => x.id === I.a2)!.recheck).toEqual({ kind: "no" });
  });
});

describe("GET breaks: amount range and checked again", () => {
  const facets = async (qs = "") => json<{ checked: Record<string, number> }>(call("GET", `/v1/spaces/${A}/breaks/facets${qs}`, { token: t.op }));
  it("amountMin / amountMax in major units of each item's currency, on the absolute amount; list, facets and summary alike", async () => {
    // P1 100.00 IDR, P2 -250.00 IDR, P3 5.00 EUR
    expect((await list("?amountMin=100&sort=amount")).map((x) => x.ref)).toEqual(["P1", "P2"]);
    expect((await list("?amountMin=100.01&sort=amount")).map((x) => x.ref)).toEqual(["P2"]);
    expect((await list("?amountMax=100&sort=amount")).map((x) => x.ref)).toEqual(["P3", "P1"]);
    expect((await list("?amountMin=5&amountMax=5")).map((x) => x.ref)).toEqual(["P3"]);
    expect(await json<BreakSummaryDto>(summary(A, t.op, "?amountMin=100"))).toMatchObject({ open: 2, amounts: [{ currency: "IDR", amountMinor: "35000", items: 2 }] });
    expect((await json<{ reason: Record<string, number> }>(call("GET", `/v1/spaces/${A}/breaks/facets?amountMax=100`, { token: t.op }))).reason).toEqual({ "No counterpart": 2 });
    for (const bad of ["abc", "-1", "1e3", "1.2.3", "."]) expect((await call("GET", `/v1/spaces/${A}/breaks?amountMin=${bad}`, { token: t.op })).status).toBe(400);
  });

  it("checked=yes|no: whether runs look for the counterpart again from today, as each row's recheck says", async () => {
    // carry over 1 day on D (past): nothing is checked again
    expect((await list("?checked=no")).length).toBe(3);
    expect(await list("?checked=yes")).toEqual([]);
    expect((await facets()).checked).toEqual({ no: 3 });
    // carry over always: the late-match No counterpart break is checked on every run
    await db.update(reconConfigVersions).set({ spec: sql`jsonb_set(${reconConfigVersions.spec}, '{carry_over_days}', 'null'::jsonb)` }).where(eq(reconConfigVersions.configId, CFG));
    const yes = await list("?checked=yes");
    expect(yes.map((x) => [x.id, x.recheck])).toEqual([[I.a1, { kind: "always" }]]);
    expect((await list("?checked=no")).every((x) => x.recheck.kind === "no")).toBe(true);
    expect((await facets()).checked).toEqual({ yes: 1, no: 2 });
    expect((await facets("?checked=yes")).checked).toEqual({ yes: 1, no: 2 }); // its own filter left out
    expect(await json<BreakSummaryDto>(summary(A, t.op, "?checked=yes"))).toMatchObject({ open: 1 });
    // a signed-off day is not checked again
    await db.insert(reconDays).values({ spaceId: A, configId: CFG, businessDate: D, status: "closed", signedAt: new Date() });
    expect(await list("?checked=yes")).toEqual([]);
    expect((await list("?sort=amount")).find((x) => x.id === I.a1)!.recheck).toEqual({ kind: "no" });
    expect((await call("GET", `/v1/spaces/${A}/breaks?checked=maybe`, { token: t.op })).status).toBe(400);
  });
});

describe("GET breaks/summary", () => {
  it("open items, the amount per currency (absolute, largest first), past carry over and mine, with the list's filters", async () => {
    await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
    const s = await json<BreakSummaryDto>(summary(A, t.op));
    expect(s).toEqual({ open: 3, amounts: [{ currency: "IDR", amountMinor: "35000", items: 2 }, { currency: "EUR", amountMinor: "500", items: 1 }], pastCarryOver: today > "2026-11-03" ? 3 : 0, mine: 1 });
    expect(await json<BreakSummaryDto>(summary(A, t.op, "?reason=Amount%20differs"))).toMatchObject({ open: 1, amounts: [{ currency: "IDR", amountMinor: "25000", items: 1 }], mine: 0 });
    expect(await json<BreakSummaryDto>(summary(A, t.op, "?q=P3"))).toMatchObject({ open: 1, amounts: [{ currency: "EUR", amountMinor: "500", items: 1 }] });
  });

  it("the headline currency is the one with the most items, not the most minor units", async () => {
    // two more EUR items of 1.00: EUR has 3 items worth 7.00, IDR 2 worth 350.00
    const more = await put(SA, [{ ref: "P4", amount: 100n, ccy: "EUR" }, { ref: "P5", amount: -100n, ccy: "EUR" }]);
    await db.insert(reconItems).values(more.map((recordId) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId, side: "a", status: "break", businessDate: D, breakReason: "No counterpart" })));
    expect((await json<BreakSummaryDto>(summary(A, t.op))).amounts).toEqual([{ currency: "EUR", amountMinor: "700", items: 3 }, { currency: "IDR", amountMinor: "35000", items: 2 }]);
  });

  it("a member of another space reads its own (none of these), a platform admin without a role is 403, a bad filter 400 first", async () => {
    expect(await json<BreakSummaryDto>(summary(B, t.out))).toEqual({ open: 0, amounts: [], pastCarryOver: 0, mine: 0 });
    expect((await summary(A, t.out)).status).toBe(403);
    expect((await summary(A, t.sa)).status).toBe(403);
    expect((await call("GET", `/v1/spaces/${A}/breaks/summary?age=old`)).status).toBe(400);
  });
});
