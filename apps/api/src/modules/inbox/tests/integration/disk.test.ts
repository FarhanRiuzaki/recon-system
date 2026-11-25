// The inbox's disk layer on a temporary folder (no database): uploads land whole or not at all.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError } from "../../../../kernel/errors";
import { ensureRoot, hideFile, listFolders, makeFolder, removeFolder, unhideFile, writeUpload } from "../../disk";

let base: string, root: string, dir: string;
beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "inbox-disk-"));
  root = path.join(base, "msi");
  await ensureRoot(root);
  await makeFolder(root, "act");
  dir = path.join(root, "act");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const streamOf = (chunks: string[], failAfter?: number) => new ReadableStream<Uint8Array>({
  start(c) {
    chunks.forEach((x, i) => { if (failAfter === i) c.error(new Error("aborted")); else if (failAfter === undefined || i < failAfter) c.enqueue(new TextEncoder().encode(x)); });
    if (failAfter === undefined) c.close();
  },
});
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const codeOf = async (p: Promise<unknown>) => { const e = await p.catch((x) => x); expect(e).toBeInstanceOf(ApiError); return (e as ApiError).code; };

describe("writeUpload", () => {
  it("writes the whole file, answers its size and sha256, leaves no temporary file", async () => {
    const got = await writeUpload(dir, "act20261125.txt", streamOf(["a|b\n", "c|d\n", "e|f\n"]), 1024);
    expect(got).toEqual({ size: 12, sha256: sha("a|b\nc|d\ne|f\n") });
    expect(readFileSync(path.join(dir, "act20261125.txt"), "utf8")).toBe("a|b\nc|d\ne|f\n");
    expect(readdirSync(dir)).toEqual(["act20261125.txt"]);
  });

  it("refuses a name already in the folder and keeps the first file", async () => {
    await writeUpload(dir, "a.txt", streamOf(["one"]), 1024);
    expect(await codeOf(writeUpload(dir, "a.txt", streamOf(["two"]), 1024))).toBe("duplicate");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  it("two uploads of one name at once: one lands, the other is a duplicate", async () => {
    const r = await Promise.allSettled([writeUpload(dir, "b.txt", streamOf(["x".repeat(5000)]), 1 << 20), writeUpload(dir, "b.txt", streamOf(["y".repeat(5000)]), 1 << 20)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(((r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason as ApiError).code).toBe("duplicate");
    expect(readdirSync(dir)).toEqual(["b.txt"]);
  });

  it("a stream that breaks leaves nothing in the folder", async () => {
    const e = await writeUpload(dir, "c.txt", streamOf(["part", "rest"], 1), 1024).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a body over the limit is refused with the limit in MB and leaves nothing", async () => {
    const e = await writeUpload(dir, "d.txt", streamOf(["x".repeat(600_000), "x".repeat(600_000)]), 1 << 20).catch((x) => x);
    expect((e as ApiError).code).toBe("too_large");
    expect((e as ApiError).message).toBe("The file is over 1 MB.");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a name of the longest length (255 bytes) uploads and hides: the temporary names don't grow with it", async () => {
    const long = `${"a".repeat(251)}.txt`;
    await writeUpload(dir, long, streamOf(["x"]), 1024);
    expect(readdirSync(dir)).toEqual([long]);
    const hidden = await hideFile(dir, long);
    await unhideFile(hidden, dir, long);
    expect(readdirSync(dir)).toEqual([long]);
  });

  it("the content check sees the first 64 KB (a workbook's part names can sit past 4 KB), and nothing is written before it", async () => {
    const seen: number[] = [];
    await writeUpload(dir, "w.txt", streamOf(["a".repeat(30_000), "b".repeat(30_000), "c".repeat(30_000)]), 1 << 20, 90_000, (head) => { seen.push(head.length); });
    expect(seen).toHaveLength(1);
    expect(seen[0]!).toBeGreaterThanOrEqual(65_536);
  });

  it("a name with a folder or a leading dot is refused before anything is written", async () => {
    expect(await codeOf(writeUpload(dir, "../x.txt", streamOf(["x"]), 1024))).toBe("bad_request");
    expect(await codeOf(writeUpload(dir, ".x", streamOf(["x"]), 1024))).toBe("bad_request");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("folders", () => {
  it("lists folders with their regular, non-dot files; skips names that aren't folder names", async () => {
    writeFileSync(path.join(dir, "a.txt"), "abc");
    writeFileSync(path.join(dir, ".a.txt.uploading"), "x");
    mkdirSync(path.join(root, "Not-A-Folder"));
    const list = await listFolders(root);
    expect(list.map((f) => f.name)).toEqual(["act"]);
    expect(list[0]!.files.map((f) => [f.name, f.size])).toEqual([["a.txt", 3]]);
  });

  it("removing a folder clears upload leftovers an hour old; a fresh one means an upload is under way", async () => {
    const left = path.join(dir, `.${Bun.randomUUIDv7()}.uploading`);
    writeFileSync(left, "x");
    expect([await codeOf(removeFolder(root, "act")), (await removeFolder(root, "act").catch((e) => e)).message]).toEqual(["invalid_state", "An upload into this folder is under way. Try again in a few minutes."]);
    const t = new Date(Date.now() - 2 * 3600_000);
    utimesSync(left, t, t);
    await removeFolder(root, "act");
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a folder that exists, and removing one that holds files", async () => {
    expect(await codeOf(makeFolder(root, "act"))).toBe("duplicate");
    writeFileSync(path.join(dir, "a.txt"), "x");
    expect(await codeOf(removeFolder(root, "act"))).toBe("invalid_state");
    rmSync(path.join(dir, "a.txt"));
    await removeFolder(root, "act");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("hideFile", () => {
  it("putting a hidden file back never overwrites a file of that name that arrived meanwhile", async () => {
    writeFileSync(path.join(dir, "a.txt"), "old");
    const hidden = await hideFile(dir, "a.txt");
    writeFileSync(path.join(dir, "a.txt"), "new");
    expect(await codeOf(unhideFile(hidden, dir, "a.txt"))).toBe("duplicate");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("new");
  });

  it("renames a file out of sight and back", async () => {
    writeFileSync(path.join(dir, "a.txt"), "x");
    const hidden = await hideFile(dir, "a.txt");
    expect((await listFolders(root))[0]!.files).toEqual([]);
    await unhideFile(hidden, dir, "a.txt");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });
});
