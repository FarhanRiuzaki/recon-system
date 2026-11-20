// Day close (spec §9 "Tutup hari", DEC-043, DEC-046; minimal in phase 1, sign-off is Plan 5): once a business date's
// close moment (rules.ts closeMoment) has passed, it waits for every side's source to be complete through the date's
// end (source_cursors.complete_through); past close + grace_minutes it closes anyway, marked incomplete per side. Its
// open items become breaks with the near-miss classifier's reason, its unconfirmed suggestions breaks with their pass's
// reason and their pair kept (sql/days.ts closeDaySql). One transaction under configLock; a date closes once. The
// engine never writes `records` or source_day_counts here either.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { and, eq, or, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { configLock } from "../../kernel/locks";
import { currentRecord, endOfDay, sourceCursors } from "../ingest";
import { reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { closeMoment } from "./rules";
import { reconDays } from "./schema";
import { addDays, load } from "./service";
import { closeDaySql } from "./sql/days";

/** What closeDay did: closed it now, it waits for data (closing), its close moment hasn't come, it was closed already. */
export type DayClose = "closed" | "closing" | "not_due" | "already";
/** A side whose source was not complete through the date's end when it closed. */
export type IncompleteSide = { side: "a" | "b"; sourceId: string; completeThrough: string | null };

/** The latest closed business date of config `configId` on or after `since` (a run's default range), null when none. */
export async function lastClosedDay(tx: InTx, spaceId: string, configId: string, since: string): Promise<string | null> {
  const [r] = await tx.select({ d: sql<string | null>`max(${reconDays.businessDate})::text` }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.status, "closed"), sql`${reconDays.businessDate} >= ${since}::date`));
  return r?.d ?? null;
}

/**
 * Closes business date `d` of config `configId` under version `versionId` (the published one) at `now`, on `on` (the
 * worker's pool). Live items only.
 */
export async function closeDay(on: Tx, k: { spaceId: string; configId: string; versionId: string }, d: string, now = new Date()): Promise<DayClose> {
  return withSpace({ spaceIds: [k.spaceId], userId: null }, async (tx) => {
    await configLock(tx, k.configId);
    const key = and(eq(reconDays.spaceId, k.spaceId), eq(reconDays.configId, k.configId), eq(reconDays.businessDate, d));
    const [day] = await tx.select({ status: reconDays.status }).from(reconDays).where(key);
    if (day?.status === "closed") return "already";
    const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, k.spaceId), eq(reconConfigVersions.id, k.versionId)));
    const { spec, sides } = await load(tx, k.spaceId, ReconSpec.parse(v!.spec));
    const at = closeMoment(spec, d);
    if (now < at) return "not_due";
    const end = endOfDay(d);
    const cursors = await tx.select({ spaceId: sourceCursors.spaceId, sourceId: sourceCursors.sourceId, ct: sourceCursors.completeThrough }).from(sourceCursors)
      .where(or(...sides.map((s) => and(eq(sourceCursors.spaceId, s.sourceSpaceId), eq(sourceCursors.sourceId, s.sourceId)))));
    const incomplete = sides.flatMap((s): IncompleteSide[] => {
      const ct = cursors.find((x) => x.spaceId === s.sourceSpaceId && x.sourceId === s.sourceId)?.ct ?? null;
      return ct && ct >= end ? [] : [{ side: s.key, sourceId: s.sourceId, completeThrough: ct?.toISOString() ?? null }];
    });
    if (incomplete.length && now.getTime() < at.getTime() + spec.grace_minutes * 60_000) {
      if (!day) await tx.insert(reconDays).values({ spaceId: k.spaceId, configId: k.configId, businessDate: d, status: "closing" }).onConflictDoNothing();
      return "closing";
    }
    const carry = spec.carry_over_days;
    const [n] = (await tx.execute(closeDaySql({
      spaceId: k.spaceId, configId: k.configId, simRunId: null, sides, current: currentRecord(tx)!, lo: addDays(d, -carry), hi: d,
    }))) as unknown as { open: number; suggested: number }[];
    const closed = { status: "closed", incomplete: incomplete.length ? incomplete : null, counters: n, closedAt: sql`now()` } as const;
    await tx.insert(reconDays).values({ spaceId: k.spaceId, configId: k.configId, businessDate: d, ...closed })
      .onConflictDoUpdate({ target: [reconDays.spaceId, reconDays.configId, reconDays.businessDate], set: closed });
    return "closed";
  }, on);
}
