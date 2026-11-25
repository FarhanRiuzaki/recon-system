// A file inbox source reads only its own space's inbox folders (Inbox files): a folder under another space's root
// (<first INBOX_ROOTS>/<other code>/…) is refused when the spec is saved and when a folder is tested; the own space's
// folders and folders outside every space root (set up by IT) stay allowed.
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { SourceDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { ksei } from "../spec";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
let A: string, codeA: string, codeB: string, adm: string, mk: string;
const base = () => `/v1/spaces/${A}/sources`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const REFUSED = "Check input.path: Use a folder of this space.";

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  const B = Bun.randomUUIDv7();
  codeA = `sa${A.slice(-8)}`; codeB = `sb${B.slice(-8)}`;
  await db.insert(spaces).values([{ id: A, code: codeA, name: "MSI" }, { id: B, code: codeB, name: "CTOP" }]);
  const grant = async (username: string, role: SpaceRole) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    await db.insert(spaceMembers).values({ spaceId: A, userId: u!.id, role });
  };
  await grant("admin", "source_admin");
  await grant("viewer", "config_maker");
  adm = await signIn("admin"); mk = await signIn("viewer");
  for (const c of [codeA, codeB]) mkdirSync(path.join(ROOT, c, "act"), { recursive: true });
  mkdirSync(path.join(ROOT, "legacy-it"), { recursive: true });
});

const saveWith = async (p: string) => {
  const s = await json<SourceDto>(call("POST", base(), { token: adm, body: { code: `f${Date.now()}`, name: "F", kind: "file_inbox" } }));
  const v = await json<SourceVersionDto>(call("POST", `${base()}/${s.id}/versions`, { token: mk }));
  const k = ksei();
  return { s, r: await call("PATCH", `${base()}/${s.id}/versions/${v.id}`, { token: adm, body: { spec: { ...k, input: { ...k.input, path: p } } } }) };
};

describe("saving a file inbox spec", () => {
  it("refuses a folder of another space, and that space's root itself", async () => {
    for (const p of [path.join(ROOT, codeB, "act"), path.join(ROOT, codeB), path.join(ROOT, codeA, "..", codeB, "act")]) {
      const { r } = await saveWith(p);
      expect([r.status, (await errOf(r)).message], p).toEqual([400, REFUSED]);
    }
  });

  it("refuses a link under its own space (or outside every space root) that leads into another space's folder", async () => {
    const viaOwn = path.join(ROOT, codeA, `peek${Date.now()}`);
    const viaLegacy = path.join(ROOT, `legacy-peek${Date.now()}`);
    symlinkSync(path.join(ROOT, codeB, "act"), viaOwn);
    symlinkSync(path.join(ROOT, codeB, "act"), viaLegacy);
    for (const p of [viaOwn, viaLegacy]) {
      const { r } = await saveWith(p);
      expect([r.status, (await errOf(r)).message], p).toEqual([400, REFUSED]);
    }
  });

  it("takes a folder of its own space and a folder outside every space root", async () => {
    for (const p of [path.join(ROOT, codeA, "act"), path.join(ROOT, "legacy-it")]) expect((await saveWith(p)).r.status, p).toBe(200);
  });
});

describe("testing a folder", () => {
  it("refuses another space's folder for a stored source and for a new one; its own space's folder reads", async () => {
    const { s } = await saveWith(path.join(ROOT, codeA, "act"));
    let r = await call("POST", `${base()}/${s.id}/connection/test`, { token: adm, body: { path: path.join(ROOT, codeB, "act"), pattern: "*" } });
    expect([r.status, (await errOf(r)).message]).toEqual([400, REFUSED]);
    r = await call("POST", `${base()}/connection-test`, { token: adm, body: { kind: "file_inbox", path: path.join(ROOT, codeB, "act"), pattern: "*" } });
    expect([r.status, (await errOf(r)).message]).toEqual([400, REFUSED]);
    r = await call("POST", `${base()}/connection-test`, { token: adm, body: { kind: "file_inbox", path: path.join(ROOT, codeA, "act"), pattern: "*" } });
    expect([r.status, (await json<{ ok: boolean }>(r)).ok]).toEqual([200, true]);
  });
});
