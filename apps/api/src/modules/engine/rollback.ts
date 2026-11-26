// A rollback of a recon's runs (owner, 26 Nov: roll back from the run history). POST …/runs/:runId/rollback
// (jobs.ts requestRollback, a space admin) queues a rerun of the published version over the dates of that run and every
// live run after it, with rollback_of = that run. The rerun's job first undoes, in one transaction under configLock, what
// those runs matched and broke (rollBackRuns, here), then runs as any run does, so the dates are matched again under the
// published version. Undone: their groups not reversed yet (reversed by the rerun, reason rolled_back; never deleted)
// with each member back where it stood (open, or the late-data break a pass paired), and the items they broke (or made
// not required, one-way) that are still so, back to open. Kept: the items they took in (the next run reads them as
// open items), a person's matches, write-offs and postings (no run made them), and a group a person or a later run
// reversed already. Refused, nothing changed, the rerun failed with why: a signed-off business date the rollback would
// change, a change of one of its items waiting for a decision, a run of the set not ended, the run rolled back already.
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError } from "../../kernel/errors";
import { reconRuns } from "./schema";
import type { Dated } from "./sql/pass";
import { reopenRunBreaksSql, reverseRunGroupsSql, rollbackBlockersSql } from "./sql/rollback";

const one = async <T>(tx: InTx, q: ReturnType<typeof rollbackBlockersSql>) => ((await tx.execute(q)) as unknown as T[])[0]!;

/** The live runs a rollback of `x` covers: `x` and every live run after it, not rolled back (no simulation). */
export const rollbackSet = (x: { spaceId: string; configId: string; startedAt: Date }) => and(
  eq(reconRuns.spaceId, x.spaceId), eq(reconRuns.configId, x.configId), ne(reconRuns.mode, "simulation"), isNull(reconRuns.baselineOf),
  isNull(reconRuns.rolledBackAt), gte(reconRuns.startedAt, x.startedAt),
);

/**
 * Undoes what run `rerun.rollbackOf` and every live run after it (started before the rerun) matched and broke, in `tx`
 * (the caller holds configLock and the rerun's row); marks them rolled back by the rerun. Answers the business dates it
 * changed (Dated, for the dashboard rollup); none when this rerun did it already (a job delivered again).
 */
export async function rollBackRuns(tx: InTx, rerun: { spaceId: string; configId: string; id: string; startedAt: Date; rollbackOf: string }): Promise<Dated[]> {
  const { spaceId, configId } = rerun;
  const [x] = await tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), eq(reconRuns.id, rerun.rollbackOf)));
  if (!x) throw new ApiError("not_found", "The run to roll back doesn't exist any more. Nothing was changed.");
  if (x.rolledBackAt) {
    if (x.rolledBackBy === rerun.id) return [];
    throw new ApiError("invalid_state", "That run was rolled back already. Nothing was changed.");
  }
  const set = await tx.select({ id: reconRuns.id, status: reconRuns.status }).from(reconRuns)
    .where(and(rollbackSet(x), ne(reconRuns.id, rerun.id), lte(reconRuns.startedAt, rerun.startedAt))).orderBy(asc(reconRuns.startedAt)).for("update");
  if (set.some((r) => r.status === "queued" || r.status === "running")) {
    throw new ApiError("invalid_state", "A run to roll back hasn't ended yet. Roll back again once it ends. Nothing was changed.");
  }
  const k = { spaceId, configId, runIds: set.map((r) => r.id) };
  const b = await one<{ closed: string | null; held: boolean }>(tx, rollbackBlockersSql(k));
  if (b.closed) throw new ApiError("day_closed", `Business date ${b.closed} is signed off, so what these runs did there stays. Nothing was changed.`);
  if (b.held) throw new ApiError("invalid_state", "A change of an item these runs matched or broke waits for a decision. Decide or cancel it, then roll back again. Nothing was changed.");
  const groups = await one<Dated>(tx, reverseRunGroupsSql(k, rerun.id));
  const breaks = await one<Dated>(tx, reopenRunBreaksSql(k));
  await tx.update(reconRuns).set({ rolledBackAt: sql`now()`, rolledBackBy: rerun.id }).where(and(eq(reconRuns.spaceId, spaceId), inArray(reconRuns.id, k.runIds)));
  return [groups, breaks];
}
