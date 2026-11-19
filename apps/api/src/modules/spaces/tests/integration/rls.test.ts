// Row level security through withSpace and recon_space_visible, on a temp domain table, as a role without BYPASSRLS
// (asAppRole): the test database connects as a superuser, which skips every policy.
import { beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { count, sql } from "drizzle-orm";
import { asAppRole, probe, probeIx } from "../../../../../test/helpers/app-role";
import { db, type Tx } from "../../../../kernel/db";
import { workerDb } from "../../../../kernel/worker-db";
import { withSpace } from "../../service";

const A = Bun.randomUUIDv7();
const B = Bun.randomUUIDv7();
const U = Bun.randomUUIDv7();

const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;
const first = async <R>(tx: Tx, q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as R[])[0]!;

/** A domain table as Plan 2+ declares one, dropped at commit; the app role may write it (temp tables get no default grants). */
async function makeProbe(tx: Tx, rows: [string, string][] = []): Promise<void> {
  await tx.execute(sql`create temp table probe (space_id uuid not null, ref text not null, unique (space_id, ref)) on commit drop`);
  await tx.execute(sql`alter table probe enable row level security`);
  await tx.execute(sql`alter table probe force row level security`);
  await tx.execute(sql`create policy probe_space on probe using (recon_space_visible(space_id)) with check (recon_space_visible(space_id))`);
  await tx.execute(sql`grant select, insert, update, delete on probe to recon_app_probe`);
  if (rows.length) await tx.insert(probe).values(rows.map(([spaceId, ref]) => ({ spaceId, ref })));
}
const countProbe = async (tx: Tx) => (await tx.select({ n: count() }).from(probe))[0]!.n;
const backend = async (tx: Tx) => (await first<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`)).pid;

beforeAll(async () => {
  await db.transaction((tx) => asAppRole(tx)); // creates the role, so makeProbe can grant to it
});

describe("withSpace and recon_space_visible", () => {
  it("a transaction sees only rows of the spaces it set", async () => {
    const seen = await withSpace({ spaceIds: [A], userId: U }, async (tx) => {
      await makeProbe(tx, [[A, "r1"], [B, "r2"]]);
      const asOwner = await countProbe(tx); // superuser: no policy applies
      await asAppRole(tx);
      return [asOwner, await countProbe(tx)];
    });
    expect(seen).toEqual([2, 1]);
  });

  it("without withSpace the app role sees zero rows, also on a pooled connection that ran withSpace before", async () => {
    expect(await db.transaction(async (tx) => {
      await makeProbe(tx, [[A, "r1"], [B, "r2"]]);
      await asAppRole(tx);
      return countProbe(tx);
    })).toBe(0);

    // The connection withSpace used, after its SET LOCAL ended: the setting is '' there, not NULL.
    const used = await withSpace({ spaceIds: [A, B], userId: U }, backend);
    let reused: { setting: string | null; n: number } | null = null;
    for (let i = 0; i < 50 && !reused; i++) {
      reused = await db.transaction(async (tx) => {
        if ((await backend(tx)) !== used) return null;
        await makeProbe(tx, [[A, "r1"], [B, "r2"]]);
        await asAppRole(tx);
        const { setting } = await first<{ setting: string | null }>(tx, sql`select current_setting('app.space_ids', true) as setting`);
        return { setting, n: await countProbe(tx) };
      });
    }
    expect(reused).toEqual({ setting: "", n: 0 });

    // A connection that never set it: NULL.
    const fresh = new SQL(process.env.DATABASE_URL!, { max: 1 });
    try {
      const [r] = await fresh`select current_setting('app.space_ids', true) is null as unset, recon_space_visible(${A}::uuid) as visible`;
      expect(r).toEqual({ unset: true, visible: null }); // NULL: a USING hides the row, a WITH CHECK refuses it (0008)
    } finally {
      await fresh.close();
    }
  });

  it("inserting a row for a space not in app.space_ids fails the policy", async () => {
    const e = await withSpace({ spaceIds: [A], userId: U }, async (tx) => {
      await makeProbe(tx);
      await asAppRole(tx);
      await tx.insert(probe).values({ spaceId: A, ref: "mine" });
      await tx.insert(probe).values({ spaceId: B, ref: "theirs" });
    }).catch((e: unknown) => e);
    expect(errno(e)).toBe("42501");
  });

  it("the same ref in two spaces is two rows, no 409", async () => {
    const n = await withSpace({ spaceIds: [A, B], userId: U }, async (tx) => {
      await makeProbe(tx);
      await asAppRole(tx);
      await tx.insert(probe).values([{ spaceId: A, ref: "same" }, { spaceId: B, ref: "same" }]);
      return countProbe(tx);
    });
    expect(n).toBe(2);
    const e = await withSpace({ spaceIds: [A], userId: U }, async (tx) => {
      await makeProbe(tx, [[A, "same"]]);
      await asAppRole(tx);
      await tx.insert(probe).values({ spaceId: A, ref: "same" });
    }).catch((e: unknown) => e);
    expect(errno(e)).toBe("23505");
  });

  it("an empty spaceIds list sees zero rows and may insert none", async () => {
    const seen = await withSpace({ spaceIds: [], userId: U }, async (tx) => {
      await makeProbe(tx, [[A, "r1"], [B, "r2"]]);
      await asAppRole(tx);
      return countProbe(tx);
    });
    expect(seen).toBe(0);
    const e = await withSpace({ spaceIds: [], userId: U }, async (tx) => {
      await makeProbe(tx);
      await asAppRole(tx);
      await tx.insert(probe).values({ spaceId: A, ref: "x" });
    }).catch((e: unknown) => e);
    expect(errno(e)).toBe("42501");
  });

  it("the policy itself can use an index on (space_id, …): one space of 100 in 20k rows is no Seq Scan", async () => {
    // No filter of the query's own: only the policy narrows the rows (PG 18 skip scan could use the index for x alone).
    const spaceIds = Array.from({ length: 100 }, () => Bun.randomUUIDv7());
    const plan = await withSpace({ spaceIds: [spaceIds[0]!], userId: U }, async (tx) => {
      await tx.execute(sql`create temp table probe_ix (space_id uuid not null, x int not null) on commit drop`);
      await tx.execute(sql`alter table probe_ix enable row level security`);
      await tx.execute(sql`alter table probe_ix force row level security`);
      await tx.execute(sql`create policy probe_ix_space on probe_ix using (recon_space_visible(space_id)) with check (recon_space_visible(space_id))`);
      await tx.execute(sql`grant select on probe_ix to recon_app_probe`);
      await tx.insert(probeIx).values(Array.from({ length: 20_000 }, (_, x) => ({ spaceId: spaceIds[x % 100]!, x })));
      await tx.execute(sql`create index on probe_ix (space_id, x)`);
      await tx.execute(sql`analyze probe_ix`);
      await asAppRole(tx);
      const rows = (await tx.execute(sql`explain ${tx.select().from(probeIx)}`)) as unknown as { "QUERY PLAN": string }[];
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).not.toContain("Seq Scan");
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
  });

  it("a job runs withSpace on the worker pool without a user: it sees only its space's rows", async () => {
    const seen = await withSpace({ spaceIds: [B], userId: null }, async (tx) => {
      await makeProbe(tx, [[A, "r1"], [B, "r2"], [B, "r3"]]);
      await asAppRole(tx);
      const s = await first<{ user: string; timeout: string }>(tx, sql`select current_setting('app.user_id', true) as user, current_setting('statement_timeout') as timeout`);
      return { ...s, n: await countProbe(tx) };
    }, workerDb);
    expect(seen).toEqual({ user: "", timeout: "2min", n: 2 }); // 2min: JOB_STATEMENT_TIMEOUT_MS, the worker pool's, not the API's 5s
  });

  it("refuses a space id that is not a UUID (a comma would add a space)", async () => {
    const e = await withSpace({ spaceIds: [`${A},${B}`], userId: U }, async () => "ran").catch((e: unknown) => e);
    expect(e).toBeInstanceOf(Error);
  });
});
