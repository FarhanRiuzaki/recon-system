// /v1/spaces/:spaceId/breaks* (Plan 5 Task 1): the queue reads the space's unresolved breaks, oldest first, by assignee
// (Unassigned too), state, age and reason; a space admin or reviewer assigns to a member; whoever works breaks takes
// one nobody has; working states for one's own (a reviewer moves anyone's); one activity entry per break changed.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { BulkResult, Page } from "@starterkit/shared/contracts/common";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { reconConfigs } from "../../../recon";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconItems } from "../../schema";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
/** Today in the app's time zone and a date `n` days before it. */
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const ago = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

let A: string, cfg: string;
let t: Record<"op" | "rev" | "adm" | "view" | "su" | "sa", string>;
let ids: Record<"op" | "rev", string>;
let B: Record<"old" | "mid" | "new" | "open", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  ids = { op: await idOf("viewer"), rev: await idOf("google") };
  const grant = async (username: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(username), role });
  await grant("viewer", "operator");
  await grant("google", "reviewer");
  await grant("twofa", "space_admin");
  await grant("apple", "viewer");
  cfg = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: cfg, spaceId: A, code: "bifast", name: "BI-FAST" });
  await db.transaction((tx) => ensureMonthPartitions(tx, reconItems, new Date(`${ago(40)}T00:00:00Z`), 3));
  const item = (bd: string, status: string, reason: string | null) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId: Bun.randomUUIDv7(), side: "a", status, businessDate: bd, breakReason: reason });
  const rows = { old: item(ago(40), "break", "No counterpart"), mid: item(ago(5), "break", "Amount differs"), new: item(today, "break", "No counterpart"), open: item(today, "open", null) };
  await db.insert(reconItems).values(Object.values(rows));
  B = { old: rows.old.id, mid: rows.mid.id, new: rows.new.id, open: rows.open.id };
  await db.delete(activity);
  t = { op: await signIn("viewer"), rev: await signIn("google"), adm: await signIn("twofa"), view: await signIn("apple"), su: await signIn("superadmin"), sa: await platformAdmin() };
});

const list = (token: string, qs = "") => call("GET", `/v1/spaces/${A}/breaks${qs}`, { token });
const post = (token: string, what: "assign" | "take" | "state", body: unknown) => call("POST", `/v1/spaces/${A}/breaks/${what}`, { token, body });
const rows = async (token: string, qs = "") => (await json<Page<BreakRowDto>>(list(token, qs))).items;

describe("GET breaks", () => {
  it("any role reads the unresolved breaks, oldest first, with their age; no role is 403, a bad filter 400 first", async () => {
    const r = await rows(t.view);
    expect(r.map((x) => [x.id, x.state, x.ageDays, x.recon.name])).toEqual([[B.old, "new", 40, "BI-FAST"], [B.mid, "new", 5, "BI-FAST"], [B.new, "new", 0, "BI-FAST"]]);
    expect((await list(t.sa)).status).toBe(403);
    expect((await call("GET", `/v1/spaces/${A}/breaks?age=old`)).status).toBe(400);
    expect((await list(t.su)).status).toBe(200); // a Superadmin reads every space (DEC-051)
  });

  it("filters by age bucket, reason, state and assignee (me, none)", async () => {
    expect((await rows(t.view, "?age=gt30")).map((x) => x.id)).toEqual([B.old]);
    expect((await rows(t.view, "?age=d4_7")).map((x) => x.id)).toEqual([B.mid]);
    expect((await rows(t.view, "?reason=Amount%20differs")).map((x) => x.id)).toEqual([B.mid]);
    await post(t.op, "take", { ids: [B.mid] });
    expect((await rows(t.op, "?assignee=me")).map((x) => x.id)).toEqual([B.mid]);
    expect((await rows(t.op, "?assignee=none")).map((x) => x.id)).toEqual([B.old, B.new]);
    expect((await rows(t.op, "?state=assigned")).map((x) => [x.id, x.assignee?.id])).toEqual([[B.mid, ids.op]]);
    expect((await rows(t.op, "?state=new")).length).toBe(2);
  });
});

describe("assign, take, state", () => {
  it("a reviewer assigns to a member, or back to Unassigned; an operator can't assign; a non-member is 400", async () => {
    const r = await json<BulkResult>(post(t.rev, "assign", { ids: [B.old, B.new, B.open], assigneeId: ids.op }));
    expect(r).toEqual({ done: [B.old, B.new], skipped: [{ id: B.open, code: "not_found" }] });
    expect((await rows(t.op, "?assignee=me")).map((x) => x.state)).toEqual(["assigned", "assigned"]);
    expect((await post(t.op, "assign", { ids: [B.old], assigneeId: ids.op })).status).toBe(403);
    const outsider = await post(t.rev, "assign", { ids: [B.old], assigneeId: await idOf("admin") });
    expect([outsider.status, await code(outsider)]).toEqual([400, "bad_request"]);
    expect(await json<BulkResult>(post(t.adm, "assign", { ids: [B.old], assigneeId: null }))).toEqual({ done: [B.old], skipped: [] });
    expect((await rows(t.op, "?assignee=none")).map((x) => [x.id, x.state])).toEqual([[B.old, "new"], [B.mid, "new"]]);
    const acts = await db.select({ action: activity.action, before: activity.before, after: activity.after }).from(activity).orderBy(activity.at, activity.id);
    expect(acts.map((a) => a.action)).toEqual(["break.assign", "break.assign", "break.assign"]);
    expect(acts[2]).toMatchObject({ before: { assignee: ids.op, state: "assigned" }, after: { assignee: null, state: "new" } });
  });

  it("an operator takes a break nobody has; one somebody else has is skipped", async () => {
    await post(t.rev, "assign", { ids: [B.old], assigneeId: ids.rev });
    expect(await json<BulkResult>(post(t.op, "take", { ids: [B.old, B.mid] }))).toEqual({ done: [B.mid], skipped: [{ id: B.old, code: "invalid_state" }] });
    expect((await post(t.view, "take", { ids: [B.new] })).status).toBe(403); // a viewer only reads
  });

  it("working states: one's own; a reviewer moves anyone's; a break nobody has is taken first", async () => {
    await post(t.op, "take", { ids: [B.mid] });
    await post(t.rev, "assign", { ids: [B.old], assigneeId: ids.rev });
    expect(await json<BulkResult>(post(t.op, "state", { ids: [B.mid, B.old, B.new], state: "investigating" })))
      .toEqual({ done: [B.mid], skipped: [{ id: B.old, code: "forbidden" }, { id: B.new, code: "invalid_state" }] });
    expect(await json<BulkResult>(post(t.rev, "state", { ids: [B.mid], state: "pending_external" }))).toEqual({ done: [B.mid], skipped: [] });
    expect((await rows(t.op, "?state=pending_external")).map((x) => x.id)).toEqual([B.mid]);
    expect((await post(t.op, "state", { ids: [B.mid], state: "resolved" })).status).toBe(400); // only working states here
  });
});
