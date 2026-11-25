// GET/POST/DELETE …/inbox/folders: a space's folders under <first INBOX_ROOTS>/<space code>/ (the test preload's root).
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InboxFolderListDto } from "@starterkit/shared/contracts/inbox";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { config } from "../../../../kernel/config";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
let A: string, B: string, code: string, t: Record<"src" | "op" | "vw" | "other", string>;
const base = (s = A) => `/v1/spaces/${s}/inbox/folders`;
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  code = `t${A.slice(-10)}`;
  await db.insert(spaces).values([{ id: A, code, name: "MSI" }, { id: B, code: `u${B.slice(-10)}`, name: "CTOP" }]);
  const grant = async (username: string, role: SpaceRole, space = A) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    await db.insert(spaceMembers).values({ spaceId: space, userId: u!.id, role });
  };
  await grant("admin", "source_admin");
  await grant("apple", "operator");
  await grant("viewer", "viewer");
  await grant("google", "source_admin", B);
  t = { src: await signIn("admin"), op: await signIn("apple"), vw: await signIn("viewer"), other: await signIn("google") };
  await db.delete(activity);
});
afterAll(() => rmSync(path.join(ROOT, code), { recursive: true, force: true }));

describe("GET …/inbox/folders", () => {
  it("makes the space root on first call and answers it with no folders, for any role of the space", async () => {
    const r = await call("GET", base(), { token: t.vw });
    expect(r.status).toBe(200);
    expect((await r.json()) as InboxFolderListDto).toEqual({ root: path.join(ROOT, code), folders: [] });
    expect(statSync(path.join(ROOT, code)).isDirectory()).toBe(true);
  });

  it("is 403 for someone without a role in the space", async () => {
    expect((await call("GET", base(), { token: t.other })).status).toBe(403);
  });

  it("is 409 invalid_state when the install has no inbox root", async () => {
    const roots = config().INBOX_ROOTS.splice(0);
    try {
      const r = await call("GET", base(), { token: t.src });
      expect(r.status).toBe(409);
      expect(await errOf(r)).toEqual({ code: "invalid_state", message: "File inbox isn't set up on this server." });
    } finally { config().INBOX_ROOTS.push(...roots); }
  });
});

describe("POST …/inbox/folders", () => {
  it("a source admin creates a folder; the list shows it with its counts; the activity log has it", async () => {
    const r = await call("POST", base(), { token: t.src, body: { name: "act" } });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ name: "act", files: 0, newest: null, newestAt: null, summary: { waiting: 0, ingested: 0, duplicate: 0, failed: 0 } });
    writeFileSync(path.join(ROOT, code, "act", "act20261125.txt"), "x");
    const list = (await (await call("GET", base(), { token: t.vw })).json()) as InboxFolderListDto;
    expect(list.folders.map((f) => [f.name, f.files, f.newest])).toEqual([["act", 1, "act20261125.txt"]]);
    const [a] = await db.select().from(activity);
    expect([a!.action, a!.targetId, a!.after]).toEqual(["inbox.folder_create", A, { folder: "act" }]);
  });

  it("an operator can't create one (403); a name that exists is 409; a name with upper case is 400", async () => {
    expect((await call("POST", base(), { token: t.op, body: { name: "act" } })).status).toBe(403);
    await call("POST", base(), { token: t.src, body: { name: "act" } });
    expect((await call("POST", base(), { token: t.src, body: { name: "act" } })).status).toBe(409);
    expect((await call("POST", base(), { token: t.src, body: { name: "Act" } })).status).toBe(400);
  });

  it("an archived space takes no new folder (409 space_archived)", async () => {
    await db.update(spaces).set({ status: "archived" }).where(eq(spaces.id, A));
    const r = await call("POST", base(), { token: t.src, body: { name: "act" } });
    expect([r.status, (await errOf(r)).code]).toEqual([409, "space_archived"]);
  });
});

describe("DELETE …/inbox/folders/:folder", () => {
  it("refuses a folder with files, and one a published source reads, naming the source", async () => {
    await call("POST", base(), { token: t.src, body: { name: "act" } });
    const dir = path.join(ROOT, code, "act");
    writeFileSync(path.join(dir, "a.txt"), "x");
    let r = await call("DELETE", `${base()}/act`, { token: t.src });
    expect([r.status, (await errOf(r)).message]).toEqual([409, "Delete the files in this folder first."]);
    rmSync(path.join(dir, "a.txt"));
    const sourceId = Bun.randomUUIDv7();
    await db.insert(sources).values({ id: sourceId, spaceId: A, code: "ksei-act", name: "KOFIS ACT", kind: "file_inbox" });
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin"));
    await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId, version: 1, status: "published", spec: { input: { kind: "file_inbox", path: dir, pattern: "act*.txt" } }, specHash: "h", makerId: u!.id, publishedAt: new Date() });
    r = await call("DELETE", `${base()}/act`, { token: t.src });
    expect([r.status, (await errOf(r)).message]).toEqual([409, "KOFIS ACT reads this folder. Change that source first."]);
    // a draft that points at it counts too
    await db.update(sourceVersions).set({ status: "draft", publishedAt: null }).where(eq(sourceVersions.sourceId, sourceId));
    r = await call("DELETE", `${base()}/act`, { token: t.src });
    expect([r.status, (await errOf(r)).message]).toEqual([409, "KOFIS ACT reads this folder. Change that source first."]);
  });

  it("deletes an empty folder no source reads (204, activity); an operator can't (403); an unknown or badly named one is 404", async () => {
    await call("POST", base(), { token: t.src, body: { name: "act" } });
    expect((await call("DELETE", `${base()}/act`, { token: t.op })).status).toBe(403);
    await db.delete(activity);
    expect((await call("DELETE", `${base()}/act`, { token: t.src })).status).toBe(204);
    expect(existsSync(path.join(ROOT, code, "act"))).toBe(false);
    expect((await db.select().from(activity)).map((a) => [a.action, a.before])).toEqual([["inbox.folder_delete", { folder: "act" }]]);
    expect((await call("DELETE", `${base()}/act`, { token: t.src })).status).toBe(404);
    expect((await call("DELETE", `${base()}/Bad_`, { token: t.src })).status).toBe(404);
  });
});

describe("folders of another space", () => {
  it("a space's folders are its own: space B's source admin gets 403 on A's", async () => {
    mkdirSync(path.join(ROOT, code, "act"), { recursive: true });
    expect((await call("GET", base(A), { token: t.other })).status).toBe(403);
    expect((await call("DELETE", `${base(A)}/act`, { token: t.other })).status).toBe(403);
  });
});
