// Day sign-off (Plan 5 Task 4, spec §11b, DEC-064: manual, no day close): any date that holds live items.
import { beforeEach, describe, expect, it } from "bun:test";
import type { SignoffRowDto } from "@starterkit/shared/contracts/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconDayStats, reconDays, reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

let A: string, cfg: string;
let t: Record<"op" | "op2" | "rev" | "sa", string>;
/** Items of the recon: a1 (A, 100.00, a break), b1 (B, 100.00, open), b2 (B, 99.00, a break), b3 (B, 100.00, open, EUR). */
let I: Record<"a1" | "b1" | "b2" | "b3", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (username: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(username), role });
  await grant("viewer", "operator");
  await grant("apple", "operator");
  await grant("google", "reviewer");
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  const [ra] = await put(sa, [{ ref: "P1", amount: 10_000n }]);
  const [rb1, rb2, rb3] = await put(sb, [{ ref: "P1", amount: 10_000n }, { ref: "P2", amount: 9_900n }, { ref: "P3", amount: 10_000n, ccy: "EUR" }]);
  const r = await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
  cfg = r.configId;
  const item = (side: "a" | "b", recordId: string, status: string, reason: string | null) =>
    ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId, side, status, businessDate: D, breakReason: reason });
  const rows = { a1: item("a", ra!, "break", "No counterpart"), b1: item("b", rb1!, "open", null), b2: item("b", rb2!, "break", "No counterpart"), b3: item("b", rb3!, "open", null) };
  await db.insert(reconItems).values(Object.values(rows));
  I = { a1: rows.a1.id, b1: rows.b1.id, b2: rows.b2.id, b3: rows.b3.id };
  await db.delete(activity);
  t = { op: await signIn("viewer"), op2: await signIn("apple"), rev: await signIn("google"), sa: await signIn("superadmin") };
  // the operator has the break
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
});

const path = (id: string, what = "") => `/v1/spaces/${A}/breaks/${id}${what}`;



const so = (how: "prepare" | "sign", token: string, date = D) => call("POST", `/v1/spaces/${A}/recons/${cfg}/signoffs/${how}`, { token, body: { date } });
const rows = async (token: string) => (await json<{ items: SignoffRowDto[] }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/signoffs`, { token }))).items;

describe("day sign-off: prepared by one lead, signed by another; a signed day is frozen", () => {
  beforeEach(async () => {
    // the dashboard rollup holds a row per date with live items: the list's dates
    await db.insert(reconDayStats).values({ spaceId: A, configId: cfg, businessDate: D });
    await db.insert(spaceMembers).values({ spaceId: A, userId: await idOf("apple"), role: "reviewer" }); // apple: operator + reviewer
  });

  it("a day after today can't be prepared; an operator can't; the preparer can't sign; another reviewer signs", async () => {
    const future = await so("prepare", t.rev, "2999-01-01");
    expect([future.status, await code(future)]).toEqual([409, "invalid_state"]);
    expect((await so("prepare", t.op)).status).toBe(403); // guard: reviewer or space admin
    expect((await rows(t.op))[0]).toMatchObject({ stage: "open", openBreaks: 2, blocked: "Only a reviewer or space admin of this space signs off days." });
    expect(await db.select().from(reconDays)).toEqual([]);
    expect(await json(so("prepare", t.rev))).toEqual({ date: D, stage: "prepared" });
    expect((await rows(t.rev))[0]!.blocked).toBe("You prepared this day. Another reviewer or space admin signs it off.");
    const self = await so("sign", t.rev);
    expect([self.status, await code(self)]).toEqual([409, "self_approval"]);
    expect(await json(so("sign", t.op2))).toEqual({ date: D, stage: "signed" });
    expect((await rows(t.op))[0]).toMatchObject({ stage: "signed", preparedBy: { id: await idOf("google") }, signedBy: { id: await idOf("apple") }, blocked: "Signed off." });
    expect((await json<{ total: number }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/signoffs?stage=open`, { token: t.op }))).total).toBe(0);
    expect((await json<{ total: number }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/signoffs?stage=signed`, { token: t.op }))).total).toBe(1);
    // frozen: the day's break no longer changes
    const frozen = await call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "NO_ACTION", note: "x" } });
    expect([frozen.status, await code(frozen)]).toEqual([409, "day_closed"]);
    expect(await code(await call("POST", path(I.a1, "/request"), { token: t.op, body: { kind: "write_off", note: "x" } }))).toBe("day_closed");
  });

  it("whoever resolved a break of the day can't sign it; a pending request blocks both steps", async () => {
    await so("prepare", t.rev);
    await call("POST", path(I.a1, "/match"), { token: t.op2, body: { itemIds: [I.b1] } }); // apple (a lead) resolves one
    expect((await rows(t.op2))[0]!.blocked).toBe("You settled unmatch items of this day. Another reviewer or space admin signs it off.");
    expect(await code(await so("sign", t.op2))).toBe("self_approval");
    await call("POST", path(I.b2, "/request"), { token: t.rev, body: { kind: "write_off", note: "x" } });
    const blocked = await so("sign", await signIn("superadmin"));
    expect([blocked.status, await message(blocked)]).toEqual([409, "A request waits for a checker. Decide it first."]);
  });
});
