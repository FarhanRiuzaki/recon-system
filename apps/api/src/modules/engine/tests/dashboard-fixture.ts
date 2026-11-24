// The recon dashboard's fixture (day-stats.test.ts, recon-dashboard.test.ts): two spaces, three recons, items and
// groups on business dates D and D1 written straight to the tables, a posting run of each outcome and approval requests.
//
//   space A (Treasury)  recon R1  P1–Q1 auto group · P2–Q2 by hand (P2 a resolved break) · P3 break 500 IDR (pending
//                                 write-off request) · P4 break 700 USD · P5 written off 900 IDR · Q5 open on D1
//                       recon R2  P6–Q6 auto group
//   space B (Ops)       recon RB  P7 break 1,000 IDR
//   space C (Empty)     no member, no recon
// Members: viewer = reviewer of A; apple = operator of B; google = operator of A and B. superadmin holds no membership.
import { eq } from "drizzle-orm";
import { resetData } from "../../../../test/helpers/app";
import { db } from "../../../kernel/db";
import { boss, QUEUES } from "../../../kernel/jobs";
import { statsJob, sweepStats } from "../stats";
import { ensureMonthPartitions } from "../../../kernel/partitions";
import { approvalRequests } from "../../approvals";
import { records } from "../../ingest";
import { actionRuns } from "../../integrations";
import { reconConfigs } from "../../recon";
import { spaceMembers, spaces } from "../../spaces";
import { users } from "../../users";
import { matchGroups, matchMembers, reconItems, reconRuns } from "../schema";
import { D, D1, makeSource, plainSource, put, recon, spec } from "./fixtures";

export { D, D1 };
const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
/** Noon of business date `d` in Asia/Jakarta. */
export const noon = (d: string) => new Date(`${d}T12:00:00+07:00`);
const PASS = [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }];

export async function seedDashboard() {
  await resetData();
  await db.delete(spaces);
  const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7(), C = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: B, code: "ops", name: "Ops" }, { id: C, code: "empty", name: "Empty" }]);
  await db.insert(spaceMembers).values([
    { spaceId: A, userId: await idOf("viewer"), role: "reviewer" }, { spaceId: B, userId: await idOf("apple"), role: "operator" },
    { spaceId: A, userId: await idOf("google"), role: "operator" }, { spaceId: B, userId: await idOf("google"), role: "operator" },
  ]);
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const recOf = async (space: string, name: string) => {
    const [sa, sb] = [await makeSource(space, plainSource()), await makeSource(space, plainSource())];
    const r = await recon(space, spec(sa.sourceId, sb.sourceId, PASS));
    await db.update(reconConfigs).set({ name }).where(eq(reconConfigs.id, r.configId));
    return { ...r, sa, sb };
  };
  const R1 = await recOf(A, "Gateway"), R2 = await recOf(A, "Cards"), RB = await recOf(B, "Branch");
  const I: Record<string, string> = {}, G: Record<string, string> = {};
  /** Items of recon `r` on side a (refs P…) or b (Q…), with their records. */
  const items = async (r: typeof R1, rows: { ref: string; amount: bigint; ccy?: string; date?: string; over?: Partial<typeof reconItems.$inferInsert> }[]) => {
    for (const side of ["a", "b"] as const) {
      const mine = rows.filter((x) => (x.ref.startsWith("P") ? "a" : "b") === side);
      if (!mine.length) continue;
      const ids = await put(side === "a" ? r.sa : r.sb, mine.map((x) => ({ ref: x.ref, amount: x.amount, ccy: x.ccy, date: x.date })));
      await db.insert(reconItems).values(mine.map((x, i) => {
        I[x.ref] = Bun.randomUUIDv7();
        return { id: I[x.ref]!, spaceId: r.spaceId, configId: r.configId, recordId: ids[i]!, side, status: "matched", businessDate: x.date ?? D, ...x.over };
      }));
    }
  };
  const group = async (r: typeof R1, key: string, kind: string, refs: string[]) => {
    G[key] = Bun.randomUUIDv7();
    await db.insert(matchGroups).values({ id: G[key]!, spaceId: r.spaceId, configId: r.configId, configVersionId: r.versionId, passNo: kind === "auto" ? 1 : 0, kind, businessDate: D, evidence: {} });
    await db.insert(matchMembers).values(refs.map((k) => ({ groupId: G[key]!, spaceId: r.spaceId, itemId: I[k]!, side: k.startsWith("P") ? "a" : "b" })));
  };
  await items(R1, [
    { ref: "P1", amount: 10_000n }, { ref: "Q1", amount: 10_000n },
    { ref: "P2", amount: 2_000n, over: { resolution: "MATCHED_MANUAL", breakReason: "No counterpart", breakState: "resolved", stateAt: noon(D1) } }, { ref: "Q2", amount: 2_000n },
    { ref: "P3", amount: 500n, over: { status: "break", breakReason: "No counterpart" } },
    { ref: "P4", amount: 700n, ccy: "USD", over: { status: "break", breakReason: "Amount differs" } },
    { ref: "P5", amount: 900n, over: { status: "closed", resolution: "WRITTEN_OFF", breakReason: "No counterpart", breakState: "resolved", stateAt: noon(D) } },
    { ref: "Q5", amount: 300n, date: D1, over: { status: "open" } },
  ]);
  await group(R1, "auto", "auto", ["P1", "Q1"]);
  await group(R1, "manual", "manual", ["P2", "Q2"]);
  await items(R2, [{ ref: "P6", amount: 100n }, { ref: "Q6", amount: 100n }]);
  await group(R2, "auto2", "auto", ["P6", "Q6"]);
  await items(RB, [{ ref: "P7", amount: 1_000n, over: { status: "break", breakReason: "No counterpart" } }]);
  // a live run of R1 (the recons table's last run)
  await db.insert(reconRuns).values({ id: Bun.randomUUIDv7(), spaceId: A, configId: R1.configId, configVersionId: R1.versionId, mode: "daily", dateFrom: D, dateTo: D, status: "succeeded", startedAt: noon(D), finishedAt: noon(D) });
  // approvals of R1: P3's write-off pending since D; one decided (rejected) on D1
  const rq = (over: Partial<typeof approvalRequests.$inferInsert> & { itemId: string }) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: R1.configId, kind: "write_off", label: "Write off", note: "n", configVersionId: R1.versionId, ...over });
  const decided = rq({ itemId: I.P4!, status: "rejected", requestedAt: noon(D), decidedAt: new Date(noon(D1).getTime()) });
  await db.insert(approvalRequests).values([rq({ itemId: I.P3!, status: "pending", requestedAt: noon(D) }), decided]);
  // posting runs of R1 on D: one posted, one failed, one timeout; one posted long before the period
  const run = (status: string, at: Date, i: number) => ({ id: Bun.randomUUIDv7(), spaceId: A, requestId: decided.id, configVersionId: R1.versionId, actionIndex: i, actionName: "Post", kind: "posting", event: "approved", itemId: null, seq: i, status, createdAt: at, finishedAt: at });
  await db.insert(actionRuns).values([run("posted", noon(D), 0), run("failed", noon(D), 1), run("timeout", noon(D1), 2), run("posted", noon("2026-10-01"), 3)]);
  return { A, B, C, R1, R2, RB, I, G };
}
export type DashboardFixture = Awaited<ReturnType<typeof seedDashboard>>;

/** The rollup as the nightly sweep at `now` writes it: its jobs queued (stats.ts sweepStats), then each run as the worker would. */
export async function rollup(now: Date): Promise<void> {
  const b = await boss();
  await b.deleteAllJobs(QUEUES.reconStats);
  await sweepStats(db, now);
  for (;;) {
    const jobs = await b.fetch(QUEUES.reconStats, { batchSize: 100 });
    if (!jobs.length) return;
    for (const j of jobs) {
      await statsJob(db, j.data as { spaceId: string; configId: string; date: string });
      await b.complete(QUEUES.reconStats, j.id);
    }
  }
}
