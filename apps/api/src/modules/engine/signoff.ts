// Sign-off of a recon's closed day (Plan 5 Task 4, spec §11b): a reviewer or space admin prepares it, another one
// signs it, who neither prepared it nor resolved an item of that day (compared by user id); neither while a break
// request on its items waits for a checker. A signed day is frozen: its items' breaks no longer change (day_closed,
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
import { reconConfigs } from "../recon";
import { users } from "../users";
import { withSpace } from "../spaces";
import { approvalRequests, reconDays, reconItems } from "./schema";

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
  if (d.pending) return `${d.pending === 1 ? "A break request waits" : `${d.pending} break requests wait`} for a checker. Decide ${d.pending === 1 ? "it" : "them"} first.`;
  if (d.stage === "closed" || isSuperadmin(ctx.user.roles)) return null;
  if (d.preparedBy === ctx.user.id) return "You prepared this day. Another reviewer or space admin signs it off.";
  if (resolved) return "You resolved breaks of this day. Another reviewer or space admin signs it off.";
  return null;
}

async function configOf(tx: InTx, spaceId: string, configId: string) {
  const [c] = await tx.select({ id: reconConfigs.id, name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
  if (!c) throw notFound("recon");
  return c;
}

/** GET …/recons/{configId}/signoffs. */
export function signoffPage(ctx: Ctx, configId: string, q: SignoffListQuery): Promise<Page<SignoffRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    await configOf(tx, spaceId, configId);
    const where = and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.status, "closed"),
      q.stage === "signed" ? isNotNull(reconDays.signedAt) : q.stage === "prepared" ? and(isNotNull(reconDays.preparedAt), isNull(reconDays.signedAt))
        : q.stage === "closed" ? isNull(reconDays.preparedAt) : undefined);
    const page = await pageQuery({
      rows: tx.select().from(reconDays).where(where).$dynamic(),
      count: tx.select(one).from(reconDays).where(where).$dynamic(),
      orderBy: sortSql(q.sort ?? "-date", { date: reconDays.businessDate }, "-date", reconDays.businessDate),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const dates = page.items.map((d) => d.businessDate);
    const pending = await pendingByDate(tx, spaceId, configId, dates);
    const ids = [...new Set(page.items.flatMap((d) => [d.preparedBy, d.signedBy]).filter((x): x is string => !!x))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
    const items: SignoffRowDto[] = [];
    for (const d of page.items) {
      const day: Day = { stage: d.signedAt ? "signed" : d.preparedAt ? "prepared" : "closed", preparedBy: d.preparedBy, pending: pending.get(d.businessDate) ?? 0 };
      // the resolver rule is read only where it can decide (a prepared day someone else prepared)
      const resolved = day.stage === "prepared" && day.preparedBy !== ctx.user.id && !isSuperadmin(ctx.user.roles) ? await resolvedThatDay(tx, spaceId, configId, d.businessDate, ctx.user.id) : false;
      const counters = (d.counters ?? {}) as { open?: number };
      items.push({
        date: d.businessDate, closedAt: d.closedAt?.toISOString() ?? null, openBreaks: counters.open ?? 0, pending: day.pending, stage: day.stage,
        preparedBy: person(d.preparedBy), preparedAt: d.preparedAt?.toISOString() ?? null, signedBy: person(d.signedBy), signedAt: d.signedAt?.toISOString() ?? null,
        blocked: nextBlocked(ctx, day, resolved),
      });
    }
    return { ...page, items };
  });
}

/** POST …/signoffs/prepare (`step` prepare) and …/sign (`step` sign): the day locked, its next step's rules checked. */
export function signoffStep(ctx: Ctx, configId: string, b: SignoffBody, step: "prepare" | "sign"): Promise<SignoffResultDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, configId);
    const key = and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.businessDate, b.date));
    const [d] = await tx.select().from(reconDays).where(key).for("update");
    if (!d || d.status !== "closed") throw new ApiError("invalid_state", `${dayText(b.date)} isn't closed yet. A day is signed off after its close.`);
    const stage = d.signedAt ? "signed" : d.preparedAt ? "prepared" : "closed";
    if (step === "prepare" && stage !== "closed") throw new ApiError("invalid_state", `${dayText(b.date)} is ${stage} already.`);
    if (step === "sign" && stage !== "prepared") throw new ApiError("invalid_state", stage === "signed" ? `${dayText(b.date)} is signed off already.` : `Prepare ${dayText(b.date)} first.`);
    const pending = (await pendingByDate(tx, spaceId, configId, [b.date])).get(b.date) ?? 0;
    const resolved = step === "sign" && !isSuperadmin(ctx.user.roles) && d.preparedBy !== ctx.user.id ? await resolvedThatDay(tx, spaceId, configId, b.date, ctx.user.id) : false;
    const why = nextBlocked(ctx, { stage, preparedBy: d.preparedBy, pending }, resolved);
    if (why) throw new ApiError(pending ? "invalid_state" : lead(ctx) ? "self_approval" : "forbidden", why);
    await tx.update(reconDays).set(step === "prepare" ? { preparedBy: ctx.user.id, preparedAt: sql`now()` } : { signedBy: ctx.user.id, signedAt: sql`now()` }).where(key);
    await recordActivity(tx, ctx, {
      action: step === "prepare" ? "day.prepare" : "day.sign", target: { type: "recon", id: configId, label: c.name },
      before: { stage }, after: { date: b.date, stage: step === "prepare" ? "prepared" : "signed" },
    });
    return { date: b.date, stage: step === "prepare" ? "prepared" : "signed" };
  });
}
