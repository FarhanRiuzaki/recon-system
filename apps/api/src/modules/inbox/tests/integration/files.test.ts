// …/inbox/folders/:folder/files: list (with each reading source's state), upload (streamed, whole or nothing),
// download and delete (only a file no source has read).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@starterkit/shared/contracts/common";
import type { InboxFileDto, InboxFolderListDto, InboxUploadDto } from "@starterkit/shared/contracts/inbox";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { api, call, request, resetData, signIn } from "../../../../../test/helpers/app";
import { config } from "../../../../kernel/config";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { sourceFiles } from "../../../ingest";
import { sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { inboxUploads } from "../../schema";
import { holdTx } from "../../../../../test/helpers/db";
import { sourceLock } from "../../../../kernel/locks";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
let app: ReturnType<typeof api>;
let A: string, B: string, code: string, dir: string, t: Record<"src" | "op" | "vw" | "other", string>, adminId: string;
const files = (s = A, folder = "act") => `/v1/spaces/${s}/inbox/folders/${folder}/files`;
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** A raw upload as the BFF sends it: the bytes, their length and the name (encodeURIComponent). */
const upload = (token: string, name: string, bytes: string | ReadableStream<Uint8Array>, o: { folder?: string; length?: number | null; space?: string } = {}) => {
  const length = o.length === undefined ? (typeof bytes === "string" ? Buffer.byteLength(bytes) : null) : o.length;
  return request(app, files(o.space, o.folder), {
    method: "POST",
    headers: { "X-Internal-Token": process.env.INTERNAL_API_TOKEN!, Authorization: `Bearer ${token}`, "x-file-name": encodeURIComponent(name), "content-type": "application/octet-stream", ...(length !== null && { "content-length": String(length) }) },
    body: bytes, ...(typeof bytes !== "string" && { duplex: "half" }),
  } as RequestInit);
};
const list = async (token: string, q = "") => (await (await call("GET", `${files()}${q}`, { token })).json()) as Page<InboxFileDto>;
const readSource = async (pattern = "act*.txt") => {
  const sourceId = Bun.randomUUIDv7();
  await db.insert(sources).values({ id: sourceId, spaceId: A, code: `s-${sourceId.slice(-8)}`, name: "KOFIS ACT", kind: "file_inbox" });
  await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId, version: 1, status: "published", spec: { input: { kind: "file_inbox", path: dir, pattern } }, specHash: "h", makerId: adminId, publishedAt: new Date() });
  return sourceId;
};
const ingested = async (sourceId: string, name: string, status = "ingested") => {
  const st = statSync(path.join(dir, name));
  await db.insert(sourceFiles).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId, name, sha256: "x", size: st.size, modifiedAt: new Date(Math.floor(st.mtimeMs)), status, rowsOk: 3, rowsTotal: 4, rowsQuarantined: 1 });
};

beforeAll(() => { app = api(); });
beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  code = `f${A.slice(-10)}`;
  await db.insert(spaces).values([{ id: A, code, name: "MSI" }, { id: B, code: `g${B.slice(-10)}`, name: "CTOP" }]);
  const grant = async (username: string, role: SpaceRole, space = A) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    await db.insert(spaceMembers).values({ spaceId: space, userId: u!.id, role });
    return u!.id;
  };
  adminId = await grant("admin", "source_admin");
  await grant("apple", "operator");
  await grant("viewer", "viewer");
  await grant("google", "source_admin", B);
  t = { src: await signIn("admin"), op: await signIn("apple"), vw: await signIn("viewer"), other: await signIn("google") };
  rmSync(path.join(ROOT, code), { recursive: true, force: true });
  expect((await call("POST", `/v1/spaces/${A}/inbox/folders`, { token: t.src, body: { name: "act" } })).status).toBe(201);
  dir = path.join(ROOT, code, "act");
  await db.delete(activity);
});
afterAll(() => rmSync(path.join(ROOT, code), { recursive: true, force: true }));

describe("POST …/files (upload)", () => {
  it("an operator uploads a file: on disk whole, its sha256 answered, who uploaded it kept, one activity entry", async () => {
    const body = "a|b\nc|d\ne|f\n";
    const r = await upload(t.op, "act20261125.txt", body);
    expect(r.status).toBe(201);
    expect((await r.json()) as InboxUploadDto).toEqual({ name: "act20261125.txt", size: 12, sha256: sha(body) });
    expect(readdirSync(dir)).toEqual(["act20261125.txt"]);
    const [u] = await db.select().from(inboxUploads);
    expect([u!.folder, u!.name, u!.size, u!.sha256]).toEqual(["act", "act20261125.txt", 12, sha(body)]);
    const [a] = await db.select().from(activity);
    expect([a!.action, a!.after]).toEqual(["inbox.upload", { folder: "act", name: "act20261125.txt", size: 12, sha256: sha(body) }]);
  });

  it("a viewer can't upload (403) and nothing lands; the same name twice is 409 and the first file stays", async () => {
    expect((await upload(t.vw, "a.txt", "x")).status).toBe(403);
    expect(readdirSync(dir)).toEqual([]);
    expect((await upload(t.op, "a.txt", "one")).status).toBe(201);
    const r = await upload(t.op, "a.txt", "two");
    expect([r.status, (await errOf(r)).code]).toEqual([409, "duplicate"]);
    expect(await Bun.file(path.join(dir, "a.txt")).text()).toBe("one");
  });

  it("a name with a folder is 400; no length is 400; an unknown folder is 404", async () => {
    expect((await upload(t.op, "../x.txt", "x")).status).toBe(400);
    expect((await upload(t.op, "a.txt", new Blob(["x"]).stream(), { length: null })).status).toBe(400);
    expect((await upload(t.op, "a.txt", "x", { folder: "nope" })).status).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a body shorter than its declared length is refused and nothing is kept", async () => {
    const r = await upload(t.op, "short.txt", new Blob(["abc"]).stream(), { length: 10 });
    expect([r.status, (await errOf(r)).message]).toEqual([400, "The file arrived incomplete (3 of 10 bytes). Upload it again."]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a file over INBOX_UPLOAD_MAX_MB is 413 too_large with the limit, and nothing is kept", async () => {
    const was = config().INBOX_UPLOAD_MAX_MB;
    config().INBOX_UPLOAD_MAX_MB = 1;
    try {
      const big = "x".repeat(1024 * 1024 + 1);
      let r = await upload(t.op, "big.txt", big);
      expect([r.status, await errOf(r)]).toEqual([413, { code: "too_large", message: "The file is over 1 MB." }]);
      r = await upload(t.op, "big.txt", new Blob([big]).stream(), { length: 10 });
      expect(r.status).toBe(413);
      expect(readdirSync(dir)).toEqual([]);
      expect(await db.select().from(inboxUploads)).toEqual([]);
    } finally { config().INBOX_UPLOAD_MAX_MB = was; }
  });

  it("a stream that breaks leaves no file, no row and no entry", async () => {
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("part")); c.error(new Error("aborted")); } });
    const r = await upload(t.op, "c.txt", broken, { length: 100 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(readdirSync(dir)).toEqual([]);
    expect(await db.select().from(inboxUploads)).toEqual([]);
    expect(await db.select().from(activity)).toEqual([]);
  });

  it("space B's source admin can't upload into space A's folder", async () => {
    expect((await upload(t.other, "a.txt", "x")).status).toBe(403);
  });
});

describe("GET …/files", () => {
  it("lists files by modification time, newest first, with who uploaded each; a file copied in shows no uploader", async () => {
    await upload(t.op, "act20261124.txt", "one");
    writeFileSync(path.join(dir, "act20261125.txt"), "copied");
    const p = await list(t.vw, "?sort=name");
    expect(p.items.map((f) => [f.name, f.uploadedBy?.name ?? null])).toEqual([["act20261124.txt", "Apple User"], ["act20261125.txt", null]]);
    expect(p.total).toBe(2);
    expect((await list(t.vw, "?q=1125")).items.map((f) => f.name)).toEqual(["act20261125.txt"]);
  });

  it("each file shows the state of every published source of the space that reads the folder and matches it; the folder sums them", async () => {
    await upload(t.op, "act20261124.txt", "one");
    await upload(t.op, "act20261125.txt", "two");
    await upload(t.op, "bal20261125.txt", "bal");
    const s = await readSource();
    await ingested(s, "act20261124.txt");
    const byName = Object.fromEntries((await list(t.vw)).items.map((f) => [f.name, f.sources]));
    expect(byName["act20261124.txt"]).toEqual([{ sourceId: s, sourceName: "KOFIS ACT", state: "ingested", rowsIn: 3, rowsQuarantined: 1 }]);
    expect(byName["act20261125.txt"]!.map((x) => x.state)).toEqual(["waiting"]);
    expect(byName["bal20261125.txt"]).toEqual([]);
    const folders = (await (await call("GET", `/v1/spaces/${A}/inbox/folders`, { token: t.vw })).json()) as InboxFolderListDto;
    expect(folders.folders[0]!.summary).toEqual({ waiting: 1, ingested: 1, duplicate: 0, failed: 0 });
  });

  it("a name with spaces, upper case and accents round-trips: upload, list, download, delete", async () => {
    const name = "Laporan ACT 25-11 résumé.TXT";
    expect((await upload(t.src, name, "abc")).status).toBe(201);
    expect((await list(t.vw)).items.map((f) => f.name)).toEqual([name]);
    const d = await call("GET", `${files()}/download?name=${encodeURIComponent(name)}`, { token: t.vw });
    expect([d.status, await d.text()]).toEqual([200, "abc"]);
    expect(d.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    expect((await call("DELETE", `${files()}?name=${encodeURIComponent(name)}`, { token: t.src })).status).toBe(204);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("a folder that is a link", () => {
  it("a folder under the space root that links elsewhere (another space's folder) is not a folder of this space: 404", async () => {
    const other = path.join(ROOT, `g${B.slice(-10)}`, "act");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, "secret.txt"), "b");
    symlinkSync(other, path.join(ROOT, code, "peek"));
    expect((await call("GET", files(A, "peek"), { token: t.vw })).status).toBe(404);
    expect((await call("GET", `${files(A, "peek")}/download?name=secret.txt`, { token: t.vw })).status).toBe(404);
    expect((await upload(t.op, "x.txt", "x", { folder: "peek" })).status).toBe(404);
  });
});

describe("POST …/files/bulk-delete", () => {
  it("deletes the files no source has read; skips the read ones and missing ones with their codes; one entry per deleted file", async () => {
    await upload(t.op, "act1.txt", "a");
    await upload(t.op, "act2.txt", "b");
    const s = await readSource();
    await ingested(s, "act1.txt");
    await db.delete(activity);
    const r = await call("POST", `${files()}/bulk-delete`, { token: t.src, body: { names: ["act1.txt", "act2.txt", "none.txt"] } });
    expect([r.status, await r.json()]).toEqual([200, { done: ["act2.txt"], skipped: [{ id: "act1.txt", code: "invalid_state" }, { id: "none.txt", code: "not_found" }] }]);
    expect(readdirSync(dir)).toEqual(["act1.txt"]);
    expect((await db.select().from(activity)).map((a) => a.action)).toEqual(["inbox.file_delete"]);
  });

  it("an operator can't (403); more than 100 names is 400", async () => {
    expect((await call("POST", `${files()}/bulk-delete`, { token: t.op, body: { names: ["a"] } })).status).toBe(403);
    expect((await call("POST", `${files()}/bulk-delete`, { token: t.src, body: { names: Array.from({ length: 101 }, (_, i) => `f${i}`) } })).status).toBe(400);
  });
});

describe("GET …/files/download", () => {
  it("answers a listed file's bytes; a dot file or a missing file is 404; another space's member is 403", async () => {
    await upload(t.op, "a.txt", "bytes");
    writeFileSync(path.join(dir, ".a.txt.x.uploading"), "half");
    expect(await (await call("GET", `${files()}/download?name=a.txt`, { token: t.vw })).text()).toBe("bytes");
    expect((await call("GET", `${files()}/download?name=.a.txt.x.uploading`, { token: t.vw })).status).toBe(404);
    expect((await call("GET", `${files()}/download?name=none.txt`, { token: t.vw })).status).toBe(404);
    expect((await call("GET", `${files()}/download?name=a.txt`, { token: t.other })).status).toBe(403);
  });
});

describe("DELETE …/files?name=", () => {
  it("a source admin deletes a file no source has read (204, entry); a file a source ingested stays (409); an operator can't (403)", async () => {
    await upload(t.op, "act20261124.txt", "one");
    await upload(t.op, "act20261125.txt", "two");
    const s = await readSource();
    await ingested(s, "act20261124.txt");
    expect((await call("DELETE", `${files()}?name=act20261125.txt`, { token: t.op })).status).toBe(403);
    await db.delete(activity);
    let r = await call("DELETE", `${files()}?name=act20261124.txt`, { token: t.src });
    expect([r.status, (await errOf(r)).message]).toEqual([409, "A source has already read this file."]);
    expect(existsSync(path.join(dir, "act20261124.txt"))).toBe(true);
    r = await call("DELETE", `${files()}?name=act20261125.txt`, { token: t.src });
    expect(r.status).toBe(204);
    expect(readdirSync(dir)).toEqual(["act20261124.txt"]);
    expect((await db.select().from(activity)).map((a) => [a.action, a.before])).toEqual([["inbox.file_delete", { folder: "act", name: "act20261125.txt", size: 3 }]]);
    expect((await call("DELETE", `${files()}?name=act20261125.txt`, { token: t.src })).status).toBe(404);
  });

  it("a file a source is reading right now (its ingest holds the source's lock) stays: 409, and it is still listed", async () => {
    await upload(t.op, "act1.txt", "a");
    const s = await readSource();
    const ingest = await holdTx((tx) => sourceLock(tx, s));
    try {
      const r = await call("DELETE", `${files()}?name=act1.txt`, { token: t.src });
      expect([r.status, (await errOf(r)).message]).toEqual([409, "A source is reading this file. Try again in a minute."]);
      expect(readdirSync(dir)).toEqual(["act1.txt"]);
    } finally { await ingest.rollback(); }
    expect((await call("DELETE", `${files()}?name=act1.txt`, { token: t.src })).status).toBe(204);
  });

  it("a file refused as a duplicate or failed also stays: only a waiting file is deleted", async () => {
    await upload(t.op, "act1.txt", "a");
    const s = await readSource();
    await ingested(s, "act1.txt", "rejected");
    expect((await call("DELETE", `${files()}?name=act1.txt`, { token: t.src })).status).toBe(409);
  });
});
