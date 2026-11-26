// Sign-off of a recon's business date (Plan 5 Task 4, spec §11b, DEC-064: manual, there is no day close): any date up to
// today can be signed off, when the people decide it is done (the list shows the dates that hold live items). A reviewer or space admin prepares it, another
// one signs it, who neither prepared it nor resolved an item of that day (compared by user id); neither while a break
// request on its items waits for a checker. Signing sends the recon's posting groups up to that date (they wait for it,
// DEC-064). A signed day is frozen: its items no longer change and leave every pass's pool (day_closed,
// `assertNotSigned`). A Superadmin passes the who-did-what rules (DEC-051), never the pending-request one. Reopening a
// signed day is a request a checker decides (later release).
import type { Page } from "@starterkit/shared/contracts/common";
import type { SignoffBody, SignoffListQuery, SignoffResultDto, SignoffRowDto } from "@starterkit/shared/contracts/recon";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { formatDate } from "@starterkit/ui/lib/format";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { one, pageQuery, sortSql } from "../../kernel/pagination";
import { activity, recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { todayIn } from "../ingest";
import { reconConfigs } from "../recon";
import { users } from "../users";
import { withSpace } from "../spaces";
import { approvalRequests } from "../approvals";
import { closeGroupsOfDay } from "../integrations";
import { reconDays, reconDayStats, reconItems } from "./schema";

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
const dayText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

/** 409 day_closed when one of `dates` of the recon is signed off. */
export async function assertNotSigned(tx: InTx, spaceId: string, configId: string, dates: readonly string[]) {
  if (!dates.length) return;
  const [d] = await tx.select({ d: sql<string>`${reconDays.businessDate}::text` }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), inArray(reconDays.businessDate, [...new Set(dates)]), isNotNull(reconDays.signedAt))).limit(1);
  if (d) throw new ApiError("day_closed", `${dayText(d.d)} is signed off: its items no longer change.`);
}

/** Pending break requests per business date of the recon, for `dates`. */
async function pendingByDate(tx: InTx, spaceId: string, configId: string, dates: readonly string[]): Promise<Map<string, number>> {
  if (!dates.length) return new Map();
  const rows = await tx.select({ d: sql<string>`${reconItems.businessDate}::text`, n: sql<number>`count(*)::int` }).from(approvalRequests)
    .innerJoin(reconItems, and(eq(reconItems.spaceId, approvalRequests.spaceId), eq(reconItems.id, approvalRequests.itemId), isNull(reconItems.simRunId)))
    .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.configId, configId), eq(approvalRequests.status, "pending"), inArray(reconItems.businessDate, [...dates])))
    .groupBy(reconItems.businessDate);
  return new Map(rows.map((r) => [r.d, r.n]));
}

/** Whether `userId` resolved (matched, closed or decided) a break of the recon's day `date`. */
async function resolvedThatDay(tx: InTx, spaceId: string, configId: string, date: string, userId: string): Promise<boolean> {
  const [hit] = await tx.select({ one: sql`1` }).from(activity)
    .innerJoin(reconItems, and(eq(reconItems.spaceId, spaceId), sql`${reconItems.id}::text = ${activity.targetId}`, isNull(reconItems.simRunId)))
    .where(and(eq(activity.actorId, userId), eq(activity.targetType, "break"), inArray(activity.action, ["break.match", "break.close", "break.approve"]),
      eq(reconItems.configId, configId), eq(reconItems.businessDate, date))).limit(1);
  return !!hit;
}

type Day = { stage: SignoffRowDto["stage"]; preparedBy: string | null; pending: number };
const lead = (ctx: Ctx) => isSuperadmin(ctx.user.roles) || ctx.space!.roles.some((r) => r === "space_admin" || r === "reviewer");

/** Why the caller can't take the day's next step, or null (`resolved`: they resolved an item of that day). */
function nextBlocked(ctx: Ctx, d: Day, resolved: boolean): string | null {
  if (d.stage === "signed") return "Signed off.";
  if (!lead(ctx)) return "Only a reviewer or space admin of this space signs off days.";
  if (d.pending) return `${d.pending === 1 ? "A request waits" : `${d.pending} requests wait`} for a checker. Decide ${d.pending === 1 ? "it" : "them"} first.`;
  if (d.stage === "open" || isSuperadmin(ctx.user.roles)) return null;
  if (d.preparedBy === ctx.user.id) return "You prepared this day. Another reviewer or space admin signs it off.";
  if (resolved) return "You settled unmatch items of this day. Another reviewer or space admin signs it off.";
  return null;
}

async function configOf(tx: InTx, spaceId: string, configId: string) {
  const [c] = await tx.select({ id: reconConfigs.id, name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
  if (!c) throw notFound("recon");
  return c;
}

/** Unmatch items not resolved per business date of the recon, for `dates`. */
async function breaksByDate(tx: InTx, spaceId: string, configId: string, dates: readonly string[]): Promise<Map<string, number>> {
  if (!dates.length) return new Map();
  const rows = await tx.select({ d: sql<string>`${reconItems.businessDate}::text`, n: sql<number>`count(*)::int` }).from(reconItems)
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), eq(reconItems.status, "break"), isNull(reconItems.simRunId), inArray(reconItems.businessDate, [...dates])))
    .groupBy(reconItems.businessDate);
  return new Map(rows.map((r) => [r.d, r.n]));
}

/**
 * GET …/recons/{configId}/signoffs: the business dates that hold live items (the dashboard rollup has one row per such
 * date, recon_day_stats) with their sign-off stage (recon_days; no row = open), newest first.
 */
export function signoffPage(ctx: Ctx, configId: string, q: SignoffListQuery): Promise<Page<SignoffRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    await configOf(tx, spaceId, configId);
    const on = and(eq(reconDays.spaceId, reconDayStats.spaceId), eq(reconDays.configId, reconDayStats.configId), eq(reconDays.businessDate, reconDayStats.businessDate));
    const where = and(eq(reconDayStats.spaceId, spaceId), eq(reconDayStats.configId, configId),
      q.stage === "signed" ? eq(reconDays.status, "signed") : q.stage === "prepared" ? eq(reconDays.status, "prepared") : q.stage === "open" ? isNull(reconDays.status) : undefined);
    const page = await pageQuery({
      rows: tx.select({ date: sql<string>`${reconDayStats.businessDate}::text`, d: reconDays }).from(reconDayStats).leftJoin(reconDays, on).where(where).$dynamic(),
      count: tx.select(one).from(reconDayStats).leftJoin(reconDays, on).where(where).$dynamic(),
      orderBy: sortSql(q.sort ?? "-date", { date: reconDayStats.businessDate }, "-date", reconDayStats.businessDate),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const dates = page.items.map((r) => r.date);
    const pending = await pendingByDate(tx, spaceId, configId, dates), breaks = await breaksByDate(tx, spaceId, configId, dates);
    const ids = [...new Set(page.items.flatMap((r) => [r.d?.preparedBy, r.d?.signedBy]).filter((x): x is string => !!x))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
    const person = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? null } : null);
    const items: SignoffRowDto[] = [];
    for (const { date, d } of page.items) {
      const day: Day = { stage: d?.signedAt ? "signed" : d?.preparedAt ? "prepared" : "open", preparedBy: d?.preparedBy ?? null, pending: pending.get(date) ?? 0 };
      // the resolver rule is read only where it can decide (a prepared day someone else prepared)
      const resolved = day.stage === "prepared" && day.preparedBy !== ctx.user.id && !isSuperadmin(ctx.user.roles) ? await resolvedThatDay(tx, spaceId, configId, date, ctx.user.id) : false;
      items.push({
        date, openBreaks: breaks.get(date) ?? 0, pending: day.pending, stage: day.stage,
        preparedBy: person(d?.preparedBy), preparedAt: d?.preparedAt?.toISOString() ?? null, signedBy: person(d?.signedBy), signedAt: d?.signedAt?.toISOString() ?? null,
        blocked: nextBlocked(ctx, day, resolved),
      });
    }
    return { ...page, items };
  });
}

/**
 * POST …/signoffs/prepare (`step` prepare) and …/sign (`step` sign): the day locked (made on prepare), its next step's
 * rules checked; a date after today is refused (a day without items may be signed: nothing came that day). Signing
 * sends the recon's posting groups up to that date.
 */
export function signoffStep(ctx: Ctx, configId: string, b: SignoffBody, step: "prepare" | "sign"): Promise<SignoffResultDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, configId);
    const key = and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.businessDate, b.date));
    if (b.date > todayIn(new Date())) throw new ApiError("invalid_state", `${dayText(b.date)} hasn't started yet. Sign off a day up to today.`);
    const [d] = await tx.select().from(reconDays).where(key).for("update");
    const stage = d?.signedAt ? "signed" : d?.preparedAt ? "prepared" : "open";
    if (step === "prepare" && stage !== "open") throw new ApiError("invalid_state", `${dayText(b.date)} is ${stage} already.`);
    if (step === "sign" && stage !== "prepared") throw new ApiError("invalid_state", stage === "signed" ? `${dayText(b.date)} is signed off already.` : `Prepare ${dayText(b.date)} first.`);
    const pending = (await pendingByDate(tx, spaceId, configId, [b.date])).get(b.date) ?? 0;
    const resolved = step === "sign" && !isSuperadmin(ctx.user.roles) && d?.preparedBy !== ctx.user.id ? await resolvedThatDay(tx, spaceId, configId, b.date, ctx.user.id) : false;
    const why = nextBlocked(ctx, { stage, preparedBy: d?.preparedBy ?? null, pending }, resolved);
    if (why) throw new ApiError(pending ? "invalid_state" : lead(ctx) ? "self_approval" : "forbidden", why);
    if (step === "prepare") {
      // a prepare that raced another made the row first: the key refuses the second (409), as the stage check would
      const made = await tx.insert(reconDays).values({ spaceId, configId, businessDate: b.date, status: "prepared", preparedBy: ctx.user.id, preparedAt: sql`now()` })
        .onConflictDoNothing().returning({ d: reconDays.businessDate });
      if (!made.length) throw new ApiError("invalid_state", `${dayText(b.date)} is prepared already.`);
    } else {
      await tx.update(reconDays).set({ status: "signed", signedBy: ctx.user.id, signedAt: sql`now()` }).where(key);
      // the posting groups waited for the sign-off (DEC-064): every open one up to this date is sent now
      await closeGroupsOfDay(tx, spaceId, configId, b.date);
    }
    await recordActivity(tx, ctx, {
      action: step === "prepare" ? "day.prepare" : "day.sign", target: { type: "recon", id: configId, label: c.name },
      before: { stage }, after: { date: b.date, stage: step === "prepare" ? "prepared" : "signed" },
    });
    return { date: b.date, stage: step === "prepare" ? "prepared" : "signed" };
  });
}
