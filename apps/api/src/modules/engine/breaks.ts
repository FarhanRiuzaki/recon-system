// Day close (spec §9 "Tutup hari", DEC-043, DEC-046; minimal in phase 1, sign-off is Plan 5): once a business date's
// close moment (rules.ts closeMoment) has passed, it waits for every side's data to be complete through the date's
// end; past close + grace_minutes it closes anyway, marked incomplete per side. "Complete" is judged on what the
// latest successful run's intake of that date saw (recon_runs.seen), never on the cursor now: records that came
// after that intake are not items yet, and closing on them would lose them (with carry over 0, for good). While a run
// of the config is queued or running (between its intake and its passes) the date waits too. Its open items become
// breaks with the near-miss classifier's reason, its unconfirmed suggestions breaks with their pass's reason and their
// pair kept (sql/days.ts closeDaySql). One transaction under configLock, with the published version; a date closes
// once. What a close skipped (an item held elsewhere) or a later intake added to a closed date is swept by the next
// scheduled run (sweepClosed). The engine never writes `records` or source_day_counts here either.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { configLock } from "../../kernel/locks";
import { currentRecord, endOfDay } from "../ingest";
import { reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { closeMoment } from "./rules";
import { reconDays, reconRuns } from "./schema";
import { addDays, effectiveCarry, load, type Seen } from "./service";
import { closeDaySql } from "./sql/days";

/**
 * What closeDay did: closed it now; it waits (closing: data not complete yet, or a run under way); its close moment
 * hasn't come (or no version is published); it was closed already.
 */
export type DayClose = "closed" | "closing" | "not_due" | "already";
/** A side whose data was not complete through the date's end when it closed: what its last intake of the date saw. */
export type IncompleteSide = { side: "a" | "b"; sourceId: string; completeThrough: string | null };

/** The latest closed business date of config `configId` on or after `since` (a run's default range), null when none. */
export async function lastClosedDay(tx: InTx, spaceId: string, configId: string, since: string): Promise<string | null> {
  const [r] = await tx.select({ d: sql<string | null>`max(${reconDays.businessDate})::text` }).from(reconDays)
    .where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.status, "closed"), sql`${reconDays.businessDate} >= ${since}::date`));
  return r?.d ?? null;
}

/** What the latest successful live run of config `configId` that took in date `d` saw of each side (null: none did). */
export async function seenOn(tx: InTx, spaceId: string, configId: string, d: string): Promise<Seen[string] | null> {
  const [r] = await tx.select({ s: sql<Seen[string] | null>`${reconRuns.seen} -> ${d}::text` }).from(reconRuns)
    .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), eq(reconRuns.status, "succeeded"), ne(reconRuns.mode, "simulation"),
      sql`${reconRuns.seen} -> ${d}::text is not null`))
    .orderBy(desc(reconRuns.finishedAt)).limit(1);
  return r?.s ?? null;
}

/** The published version of config `configId`: its id, spec and sides; null when none is published. */
async function published(tx: InTx, spaceId: string, configId: string) {
  const [v] = await tx.select({ id: reconConfigVersions.id, spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
  return v ? { id: v.id, ...(await load(tx, spaceId, ReconSpec.parse(v.spec))) } : null;
}

/** A live (not simulation) run of config `configId` is queued or running. */
async function runUnderWay(tx: InTx, spaceId: string, configId: string): Promise<boolean> {
  const [r] = await tx.select({ id: reconRuns.id }).from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId),
    inArray(reconRuns.status, ["queued", "running"]), ne(reconRuns.mode, "simulation"))).limit(1);
  return !!r;
}

/** Items of one business date a close or a sweep made breaks: from open items, from unconfirmed suggestions. */
export type DayBroken = { d: string; open: number; suggested: number };
const total = (rows: readonly DayBroken[]) => rows.reduce((t, r) => ({ open: t.open + r.open, suggested: t.suggested + r.suggested }), { open: 0, suggested: 0 });

/**
 * Adds what a close or a sweep broke to each closed date's own counters (REC-FUT-17: a date's counters are its own
 * items made breaks, by its close and by every sweep after it). A date not closed yet has no counters to keep.
 */
async function addCounters(tx: InTx, k: { spaceId: string; configId: string }, rows: readonly DayBroken[]): Promise<void> {
  for (const r of rows) {
    if (!r.open && !r.suggested) continue;
    await tx.update(reconDays).set({ counters: sql`jsonb_build_object('open', coalesce((${reconDays.counters} ->> 'open')::int, 0) + ${r.open}::int,
        'suggested', coalesce((${reconDays.counters} ->> 'suggested')::int, 0) + ${r.suggested}::int)` })
      .where(and(eq(reconDays.spaceId, k.spaceId), eq(reconDays.configId, k.configId), eq(reconDays.businessDate, r.d), eq(reconDays.status, "closed")));
  }
}

/** Closes business date `d` of config `k.configId` at `now`, on `on` (the worker's pool), under its published version. */
export async function closeDay(on: Tx, k: { spaceId: string; configId: string }, d: string, now = new Date()): Promise<DayClose> {
  return withSpace({ spaceIds: [k.spaceId], userId: null }, async (tx) => {
    await configLock(tx, k.configId);
    const key = and(eq(reconDays.spaceId, k.spaceId), eq(reconDays.configId, k.configId), eq(reconDays.businessDate, d));
    const [day] = await tx.select({ status: reconDays.status }).from(reconDays).where(key);
    if (day?.status === "closed") return "already";
    const v = await published(tx, k.spaceId, k.configId);
    if (!v) return "not_due";
    const at = closeMoment(v.spec, d);
    if (now < at) return "not_due";
    if (await runUnderWay(tx, k.spaceId, k.configId)) return "closing";
    const end = endOfDay(d), seen = await seenOn(tx, k.spaceId, k.configId, d);
    const incomplete = v.sides.flatMap((s): IncompleteSide[] => {
      const ct = seen?.[s.key] ?? null;
      return ct && new Date(ct) >= end ? [] : [{ side: s.key, sourceId: s.sourceId, completeThrough: ct }];
    });
    if (incomplete.length && now.getTime() < at.getTime() + v.spec.grace_minutes * 60_000) {
      if (!day) await tx.insert(reconDays).values({ spaceId: k.spaceId, configId: k.configId, businessDate: d, status: "closing" }).onConflictDoNothing();
      return "closing";
    }
    const carry = await effectiveCarry(tx, k, v.spec.carry_over_days, d);
    const rows = (await tx.execute(closeDaySql({ spaceId: k.spaceId, configId: k.configId, simRunId: null, sides: v.sides, current: currentRecord(tx)!, carry }, addDays(d, -carry), d))) as unknown as DayBroken[];
    // the closing date's counters: its own items; carried-over items of dates closed before count on those dates
    const own = rows.find((r) => r.d === d) ?? { open: 0, suggested: 0 };
    const closed = { status: "closed", incomplete: incomplete.length ? incomplete : null, counters: { open: own.open, suggested: own.suggested }, closedAt: sql`now()` } as const;
    await tx.insert(reconDays).values({ spaceId: k.spaceId, configId: k.configId, businessDate: d, ...closed })
      .onConflictDoUpdate({ target: [reconDays.spaceId, reconDays.configId, reconDays.businessDate], set: closed });
    await addCounters(tx, k, rows.filter((r) => r.d !== d));
    return "closed";
  }, on);
}

/**
 * Closed dates `lo`..`hi` of config `k.configId` again: their open items and unconfirmed suggestions (an item a close
 * skipped while another transaction held it, a record a later intake took in within carry over) become breaks, so a
 * closed date keeps none open. Only dates that are closed, and not while a run of the recon is under way (its intake
 * may have added items its passes haven't seen). Each date's counters take what it broke there (REC-FUT-17).
 * Answers { open, suggested } it broke and the dates it broke items on.
 */
export async function sweepClosed(on: Tx, k: { spaceId: string; configId: string }, lo: string, hi: string): Promise<{ open: number; suggested: number; dates: string[] }> {
  const none = { open: 0, suggested: 0, dates: [] as string[] };
  return withSpace({ spaceIds: [k.spaceId], userId: null }, async (tx) => {
    await configLock(tx, k.configId);
    if (await runUnderWay(tx, k.spaceId, k.configId)) return none;
    const [r] = await tx.select({ lo: sql<string | null>`min(${reconDays.businessDate})::text`, hi: sql<string | null>`max(${reconDays.businessDate})::text` }).from(reconDays)
      .where(and(eq(reconDays.spaceId, k.spaceId), eq(reconDays.configId, k.configId), eq(reconDays.status, "closed"),
        sql`${reconDays.businessDate} between ${lo}::date and ${hi}::date`));
    const v = r?.lo && r.hi ? await published(tx, k.spaceId, k.configId) : null;
    if (!v || !r?.lo || !r.hi) return none;
    // ponytail: a gap (a date never closed) between closed dates of the window would be swept too; closes run in order
    const rows = (await tx.execute(closeDaySql({ spaceId: k.spaceId, configId: k.configId, simRunId: null, sides: v.sides, current: currentRecord(tx)!, carry: await effectiveCarry(tx, k, v.spec.carry_over_days, r.hi) }, r.lo, r.hi))) as unknown as DayBroken[];
    await addCounters(tx, k, rows);
    return { ...total(rows), dates: rows.filter((x) => x.open || x.suggested).map((x) => x.d) };
  }, on);
}
