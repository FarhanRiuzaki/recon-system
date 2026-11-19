// The connection test of a file inbox source: is its folder readable, and how many files does its pattern match now.
// The folder must sit inside one of the install's inbox roots (INBOX_ROOTS, kernel/config.ts), checked on the path as
// written and again after symlinks are followed (realpath), so a link inside a root can't lead out of it. Only regular
// files count (no folders, no links). A failure names the system's code (ENOENT, EACCES), never the path.
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../kernel/errors";

const outside = () => new ApiError("bad_request", "The folder must be inside one of the inbox folders this install allows (INBOX_ROOTS).");
const within = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
const failed = (e: unknown) => {
  const code = (e as { code?: unknown }).code;
  return { ok: false, message: `The folder can't be read${typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : ""}. Check that it exists and that this server may read it.` };
};

/** 400 for a folder outside `roots` or a pattern with a path in it; otherwise whether the folder reads, and the count. */
export async function inboxProbe(roots: string[], dir: string, pattern: string): Promise<{ ok: boolean; message: string }> {
  if (/[/\\]/.test(pattern)) throw new ApiError("bad_request", "The file pattern matches file names only: no folders in it.");
  if (!path.isAbsolute(dir) || !within(path.resolve(dir), roots.map((r) => path.resolve(r)))) throw outside();
  let real: string;
  try { real = await realpath(dir); } catch (e) { return failed(e); }
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => path.resolve(r))));
  if (!within(real, realRoots)) throw outside();
  let names: string[];
  try {
    const glob = new Bun.Glob(pattern);
    names = (await readdir(real, { withFileTypes: true })).filter((e) => e.isFile() && glob.match(e.name)).map((e) => e.name);
  } catch (e) { return failed(e); }
  const n = names.length;
  return { ok: true, message: `Folder readable · ${n} ${n === 1 ? "file matches" : "files match"} ${pattern}` };
}
