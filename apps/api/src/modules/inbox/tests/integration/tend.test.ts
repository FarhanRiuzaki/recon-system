// Every space has its inbox root (owner 25 Nov: made with the space, and made for every space by the janitor), and
// temporary dot files a crash left behind are swept once a day old.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { call, platformAdmin, resetData } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { spaces } from "../../../spaces";
import { tendInbox } from "../../index";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
const made: string[] = [];
const fresh = (p: string) => p;
const old = (p: string) => { const t = new Date(Date.now() - 25 * 3600_000); utimesSync(p, t, t); return p; };

beforeEach(async () => { await resetData(); await db.delete(spaces); });
afterAll(() => { for (const c of made) rmSync(path.join(ROOT, c), { recursive: true, force: true }); });

describe("a new space", () => {
  it("gets its inbox root when it is created", async () => {
    const code = `n${Date.now().toString(36)}`;
    made.push(code);
    const r = await call("POST", "/v1/spaces", { token: await platformAdmin(), body: { code, name: "New" } });
    expect(r.status).toBe(201);
    expect(existsSync(path.join(ROOT, code))).toBe(true);
  });
});

describe("tendInbox (the janitor)", () => {
  it("makes the root of every active space that lacks one; an archived space gets none", async () => {
    const a = `ta${Date.now().toString(36)}`, b = `tb${Date.now().toString(36)}`;
    made.push(a, b);
    await db.insert(spaces).values([{ id: Bun.randomUUIDv7(), code: a, name: "A" }, { id: Bun.randomUUIDv7(), code: b, name: "B", status: "archived" }]);
    const got = await tendInbox(db);
    expect(existsSync(path.join(ROOT, a))).toBe(true);
    expect(existsSync(path.join(ROOT, b))).toBe(false);
    expect(got.inbox_roots).toBeGreaterThanOrEqual(1);
  });

  it("sweeps upload and delete leftovers a day old, keeps fresh ones and every real file", async () => {
    const c = `tc${Date.now().toString(36)}`;
    made.push(c);
    const [s] = await db.insert(spaces).values({ id: Bun.randomUUIDv7(), code: c, name: "C" }).returning();
    const dir = path.join(ROOT, c, "act");
    mkdirSync(dir, { recursive: true });
    const [a, b, c2] = [`.${Bun.randomUUIDv7()}.uploading`, `.${Bun.randomUUIDv7()}.deleting`, `.${Bun.randomUUIDv7()}.uploading`];
    writeFileSync(path.join(dir, a), "x"); old(path.join(dir, a));
    writeFileSync(path.join(dir, b), "x"); old(path.join(dir, b));
    writeFileSync(path.join(dir, c2), "x"); fresh(path.join(dir, c2));
    writeFileSync(path.join(dir, "act1.txt"), "x"); old(path.join(dir, "act1.txt"));
    const got = await tendInbox(db);
    expect(readdirSync(dir).sort()).toEqual([c2, "act1.txt"]);
    expect(got.inbox_leftovers).toBe(2);
    await db.update(spaces).set({ status: "archived" }).where(eq(spaces.id, s!.id));
  });
});
