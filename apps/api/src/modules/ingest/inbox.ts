// A file inbox source's folder (local or an NFS mount; SFTP waits for REC-Q1). The folder must sit inside one of the
// install's inbox roots (INBOX_ROOTS, kernel/config.ts), checked on the path as written and again after symlinks are
// followed (realpath), so a link inside a root can't lead out of it. Only regular files count (no folders, no links).
// A failure names the system's code (ENOENT, EACCES), never the path.
//
// - inboxProbe: the connection test (route): is the folder readable, and how many files its pattern matches now.
// - completeFiles: the files the pipeline may read now: complete once unchanged for `stable_seconds`, or once their
//   marker `<name>.done` is there (spec §7 step 3a).
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../kernel/errors";

const outside = () => new ApiError("bad_request", "Use a folder inside the inbox folders this install allows.");
const within = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : "";
};
const failed = (e: unknown) => ({ ok: false, message: `The folder can't be read${codeOf(e)}. Check that it exists and that this server may read it.` });

/** The folder's real path, inside `roots` before and after symlinks (400 otherwise); an unreadable folder throws its fs error. */
async function folder(roots: string[], dir: string): Promise<string> {
  if (!path.isAbsolute(dir) || !within(path.resolve(dir), roots.map((r) => path.resolve(r)))) throw outside();
  const real = await realpath(dir);
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => path.resolve(r))));
  if (!within(real, realRoots)) throw outside();
  return real;
}

/** 400 for a folder outside `roots` or a pattern with a path in it ("Check input.path: …"); otherwise whether the folder reads, how many files match and the newest by modification time. */
export async function inboxProbe(roots: string[], dir: string, pattern: string): Promise<{ ok: boolean; message: string }> {
  // named like a spec field (the wizard shows it on the Folder or Pattern field)
  if (/[/\\]/.test(pattern)) throw new ApiError("bad_request", "Check input.pattern: The file pattern matches file names only: no folders in it.");
  let real: string;
  try { real = await folder(roots, dir); } catch (e) { if (e instanceof ApiError) throw new ApiError("bad_request", `Check input.path: ${e.message}`); return failed(e); }
  let files: { name: string; at: number }[];
  try {
    const glob = new Bun.Glob(pattern);
    const names = (await readdir(real, { withFileTypes: true })).filter((e) => e.isFile() && glob.match(e.name)).map((e) => e.name);
    // ponytail: one stat per matching file for "newest"; an inbox holds days of files, not millions
    files = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(real, name))).mtimeMs })));
  } catch (e) { return failed(e); }
  const n = files.length;
  const newest = files.reduce<{ name: string; at: number } | null>((a, f) => (!a || f.at > a.at || (f.at === a.at && f.name > a.name) ? f : a), null);
  // "*" = the folder checked before its pattern is typed (REC-F2b)
  const count = pattern === "*" ? `${n} ${n === 1 ? "file" : "files"}` : `${n} ${n === 1 ? "file matches" : "files match"} ${pattern}`;
  return { ok: true, message: `Folder readable · ${count}${newest ? ` · newest ${newest.name}` : ""}` };
}

export type InboxEntry = { name: string; path: string; size: number; modifiedAt: number };
type FileInput = Extract<SourceSpec["input"], { kind: "file_inbox" }>;

/** Why the folder can't be read, as the source's last error. */
export class InboxError extends Error {}

/** The files of `input` complete at `now` (ms), by name; the modification time in whole milliseconds. */
export async function completeFiles(roots: string[], input: FileInput, now: number): Promise<InboxEntry[]> {
  let real: string;
  try {
    real = await folder(roots, input.path);
    const glob = new Bun.Glob(input.pattern);
    const entries = (await readdir(real, { withFileTypes: true })).filter((e) => e.isFile());
    const markers = new Set(entries.map((e) => e.name));
    const out: InboxEntry[] = [];
    for (const e of entries.filter((x) => glob.match(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(real, e.name);
      const st = await stat(p);
      const modifiedAt = Math.floor(st.mtimeMs);
      const done = input.completion.kind === "marker_file" ? markers.has(`${e.name}.done`) : now - modifiedAt >= input.completion.seconds * 1000;
      if (done) out.push({ name: e.name, path: p, size: st.size, modifiedAt });
    }
    return out;
  } catch (e) {
    if (e instanceof ApiError) throw new InboxError(e.message);
    throw new InboxError(`The folder can't be read${codeOf(e)}. Check that it exists and that this server may read it.`);
  }
}

/** File `name` of the folder, by its real path inside `roots` (a name with a path in it is refused). */
export async function inboxFile(roots: string[], dir: string, name: string): Promise<string> {
  if (/[/\\]/.test(name) || name === "." || name === "..") throw new InboxError("A file name has no folder in it.");
  try {
    return path.join(await folder(roots, dir), name);
  } catch (e) {
    throw new InboxError(e instanceof ApiError ? e.message : `The folder can't be read${codeOf(e)}.`);
  }
}

/** SHA-256 (hex) of a byte stream, read chunk by chunk. */
export async function sha256Of(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const b of bytes) h.update(b);
  return h.digest("hex");
}
