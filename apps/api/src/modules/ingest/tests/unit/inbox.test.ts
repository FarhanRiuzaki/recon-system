// The file inbox check behind the connection test (inbox.ts): the folder must sit inside an allowed root, also after
// symlinks are followed; the answer counts the regular files the pattern matches.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError } from "../../../../kernel/errors";
import { completeFiles, inboxProbe } from "../../inbox";

let dir: string, root: string, outside: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "inbox-"));
  root = path.join(dir, "root");
  outside = path.join(dir, "outside");
  mkdirSync(path.join(root, "ksei", "sub"), { recursive: true });
  mkdirSync(outside);
  for (const f of ["act20261102.txt", "act20261103.txt", "act20261104.txt", "bal20261102.txt", "act.done"]) writeFileSync(path.join(root, "ksei", f), "x");
  writeFileSync(path.join(outside, "act1.txt"), "x");
  symlinkSync(outside, path.join(root, "escape"));
  symlinkSync(path.join(outside, "act1.txt"), path.join(root, "ksei", "act-link.txt"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const refused = async (p: Promise<unknown>) => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(ApiError);
  return (e as ApiError).code;
};

describe("inboxProbe", () => {
  it("counts the regular files the pattern matches (no folders, no links) and names the newest by modification time", async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 10, d));
    for (const [f, d] of [["act20261102.txt", 5], ["act20261103.txt", 3], ["act20261104.txt", 4], ["bal20261102.txt", 2], ["act.done", 1]] as const) utimesSync(path.join(root, "ksei", f), day(d), day(d));
    expect(await inboxProbe([root], path.join(root, "ksei"), "act*.txt")).toEqual({ ok: true, message: "Folder readable · 3 files match act*.txt · newest act20261102.txt" });
    expect(await inboxProbe([root], path.join(root, "ksei"), "bal*.txt")).toEqual({ ok: true, message: "Folder readable · 1 file matches bal*.txt · newest bal20261102.txt" });
    expect(await inboxProbe([root], path.join(root, "ksei"), "*.pdf")).toEqual({ ok: true, message: "Folder readable · 0 files match *.pdf" });
    // checked before the pattern is typed (REC-F2b): every file
    expect(await inboxProbe([root], path.join(root, "ksei"), "*")).toEqual({ ok: true, message: "Folder readable · 5 files · newest act20261102.txt" });
  });

  it("a folder outside every root is 400, also through a symlink or a dot segment; so is a pattern with a slash", async () => {
    expect(await refused(inboxProbe([root], outside, "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([root], path.join(root, "escape"), "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([root], `${root}/ksei/../../outside`, "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([root], `${root}-not`, "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([root], "ksei", "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([], path.join(root, "ksei"), "*"))).toBe("bad_request");
    expect(await refused(inboxProbe([root], path.join(root, "ksei"), "../*.txt"))).toBe("bad_request");
  });

  it("a missing folder inside a root is a failed check with its code, never the path", async () => {
    const r = await inboxProbe([root], path.join(root, "nope"), "*");
    expect(r).toEqual({ ok: false, message: "The folder can't be read (ENOENT). Check that it exists and that this server may read it." });
  });
});

describe("dot files", () => {
  it("an upload still being written (.name.uploading) is never complete, whatever the pattern", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "inbox-dot-"));
    try {
      writeFileSync(path.join(d, ".act1.txt.uploading"), "x");
      writeFileSync(path.join(d, "act2.txt"), "x");
      const old = new Date(Date.now() - 60_000);
      for (const f of [".act1.txt.uploading", "act2.txt"]) utimesSync(path.join(d, f), old, old);
      const files = await completeFiles([d], { kind: "file_inbox", path: d, pattern: "*", completion: { kind: "stable_seconds", seconds: 1 } } as never, Date.now());
      expect(files.map((f) => f.name)).toEqual(["act2.txt"]);
      expect((await inboxProbe([d], d, "*")).message).toContain("1 file");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
