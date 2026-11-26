// What a change of direction does to a recon's not-required items (DEC-055). There is no day close any more (DEC-064):
// a live run makes what it leaves open unmatch at once (sql/days.ts breakOpenSql), so this file keeps only the reopening.
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { reconDays, reconItems } from "./schema";

/**
 * A version that is not one-way was published (DEC-055): config `configId`'s not-required items (live) are open again,
 * so the next run classifies them under the new direction (unmatch "No counterpart" when still unpaired). Items of a
 * signed-off date stay as they are (frozen). Runs in the publish transaction; answers how many it opened.
 */
export async function reopenNotRequired(tx: InTx, spaceId: string, configId: string): Promise<number> {
  const opened = await tx.update(reconItems).set({ status: "open", version: sql`${reconItems.version} + 1` })
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), eq(reconItems.status, "not_required"), isNull(reconItems.simRunId),
      notExists(tx.select({ one: sql`1` }).from(reconDays).where(and(eq(reconDays.spaceId, reconItems.spaceId), eq(reconDays.configId, reconItems.configId),
        eq(reconDays.businessDate, reconItems.businessDate), isNotNull(reconDays.signedAt))))))
    .returning({ id: reconItems.id });
  return opened.length;
}
