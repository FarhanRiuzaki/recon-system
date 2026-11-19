// The file inbox check behind the connection test (inbox.ts): the folder must sit inside an allowed root, also after
// symlinks are followed; the answer counts the regular files the pattern matches.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiError } from "../../../../kernel/errors";
import { inboxProbe } from "../../inbox";

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
  it("counts the regular files the pattern matches (no folders, no links)", async () => {
    expect(await inboxProbe([root], path.join(root, "ksei"), "act*.txt")).toEqual({ ok: true, message: "Folder readable · 3 files match act*.txt" });
    expect(await inboxProbe([root], path.join(root, "ksei"), "bal*.txt")).toEqual({ ok: true, message: "Folder readable · 1 file matches bal*.txt" });
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
