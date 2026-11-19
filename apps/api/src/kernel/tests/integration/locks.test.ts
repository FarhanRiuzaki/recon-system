import { expect, it } from "bun:test";
import { holdTx, lockWaiters } from "../../../../test/helpers/db";
import { db } from "../../db";
import { configLock } from "../../locks";

it("configLock: a second run of the same config waits until the first commits; another config does not", async () => {
  const [a, b] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  const held = await holdTx((tx) => configLock(tx, a));
  try {
    await db.transaction(async (tx) => configLock(tx, b));
    let second = false;
    const waiting = db.transaction(async (tx) => {
      await configLock(tx, a);
      second = true;
    });
    expect(await lockWaiters(1, "%pg_advisory_xact_lock%hashtext%")).toBe(true);
    expect(second).toBe(false);
    await held.commit();
    await waiting;
    expect(second).toBe(true);
  } finally {
    await held.rollback();
  }
});
