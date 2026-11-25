// The inbox's files on disk: the one place the inbox module touches the file system, so a later object store
// (MinIO or another S3, owner 25 Nov) replaces this file without changing routes or screens. Callers pass a space root
// or a folder already resolved inside the inbox roots (service.ts, through ingest's inboxFolder). An upload is written
// as a dot file and linked to its name only when whole; the file_inbox pipeline never reads a dot file.
import { INBOX_FOLDER_NAME, isInboxFileName } from "@starterkit/shared/inbox";
import { chmod, link, mkdir, open, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../kernel/errors";

import { ensureInboxDir, INBOX_DIR_MODE as DIR_MODE } from "../../kernel/inbox-root";
const FILE_MODE = 0o664;
/** How much of an upload the content check sees before anything is written. */
const SNIFF_BYTES = 64 * 1024;

export type DiskFile = { name: string; size: number; modifiedAt: number };
export type DiskFolder = { name: string; files: DiskFile[] };

const plainName = (name: string) => { if (!isInboxFileName(name)) throw new ApiError("bad_request", "Use a file name without folders, a leading dot or control characters, at most 255 bytes."); };
const folderName = (name: string) => { if (!INBOX_FOLDER_NAME.test(name)) throw new ApiError("bad_request", "Use lower case letters, digits, _ and - for a folder name, starting with a letter or digit."); };
const exists = (e: unknown) => (e as { code?: string }).code === "EEXIST";

export const ensureRoot = (root: string): Promise<void> => ensureInboxDir(root);

/** How many files are stat'ed at once (a folder FTP fills can hold thousands). */
const STAT_BATCH = 64;

/** The regular, non-dot files of `dir`, by name; a file gone between the listing and its stat is left out. */
export async function listFiles(dir: string): Promise<DiskFile[]> {
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
  const out: DiskFile[] = [];
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const got = await Promise.all(names.slice(i, i + STAT_BATCH).map(async (name) => {
      const st = await stat(path.join(dir, name)).catch(() => null);
      return st ? { name, size: st.size, modifiedAt: Math.floor(st.mtimeMs) } : null;
    }));
    for (const f of got) if (f) out.push(f);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const LEFTOVER = /^\.[0-9a-f-]{36}\.(uploading|deleting)$/;

/** Removes the upload and delete leftovers (dot files of this module) in `dir` older than `ms`; answers how many. */
export async function sweepLeftovers(dir: string, ms: number, now = Date.now()): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !LEFTOVER.test(e.name)) continue;
    const p = path.join(dir, e.name);
    const st = await stat(p).catch(() => null);
    if (st && now - st.mtimeMs >= ms) { await unlink(p).catch(() => undefined); n += 1; }
  }
  return n;
}

/** An upload left behind for this long is a crash's, not one under way. */
const STALE_UPLOAD_MS = 3600_000;

/** The folders of a space root (names that are folder names only), by name, each with its files. */
export async function listFolders(root: string): Promise<DiskFolder[]> {
  const dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && INBOX_FOLDER_NAME.test(e.name)).map((e) => e.name).sort();
  return Promise.all(dirs.map(async (name) => ({ name, files: await listFiles(path.join(root, name)) })));
}

export async function makeFolder(root: string, name: string): Promise<void> {
  folderName(name);
  try { await mkdir(path.join(root, name), { mode: DIR_MODE }); } catch (e) {
    if (exists(e)) throw new ApiError("duplicate", `A folder named ${name} already exists.`);
    throw e;
  }
  await chmod(path.join(root, name), DIR_MODE);
}

export async function removeFolder(root: string, name: string): Promise<void> {
  folderName(name);
  const dir = path.join(root, name);
  await sweepLeftovers(dir, STALE_UPLOAD_MS);
  if ((await readdir(dir).catch(() => [])).some((n) => LEFTOVER.test(n))) throw new ApiError("invalid_state", "An upload into this folder is under way. Try again in a few minutes.");
  try { await rmdir(dir); } catch (e) {
    if (["ENOTEMPTY", "EEXIST"].includes((e as { code?: string }).code ?? "")) throw new ApiError("invalid_state", "Delete the files in this folder first.");
    throw e;
  }
}

/**
 * Writes `body` to `dir/name`: first to a dot file of its own (`.<random>.uploading`), hashing while it writes;
 * over `maxBytes` (413), shorter or longer than `expected`, or a broken stream → the dot file is removed and nothing
 * lands; then linked to `name` (refused when
 * that name exists: 409 duplicate, never overwritten) and the dot file removed.
 */
export async function writeUpload(dir: string, name: string, body: ReadableStream<Uint8Array>, maxBytes: number, expected?: number, check?: (head: Uint8Array) => void): Promise<{ size: number; sha256: string }> {
  plainName(name);
  // the temporary name doesn't carry the file's: a 255-byte name would pass the file system's limit with it
  const temp = path.join(dir, `.${Bun.randomUUIDv7()}.uploading`);
  const h = new Bun.CryptoHasher("sha256");
  let size = 0;
  const fh = await open(temp, "wx", FILE_MODE);
  try {
    try {
      // the first bytes (up to 64 KB: a workbook's part names can sit past 4 KB) go to `check` before any is written
      let head: Uint8Array | null = check ? new Uint8Array(0) : null;
      for await (const chunk of body) {
        if (head) {
          head = Buffer.concat([head, chunk]);
          if (head.length < SNIFF_BYTES) continue;
          check!(head);
          size += head.byteLength;
          if (size > maxBytes) throw new ApiError("too_large", `The file is over ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
          h.update(head);
          await fh.write(head);
          head = null;
          continue;
        }
        size += chunk.byteLength;
        if (size > maxBytes) throw new ApiError("too_large", `The file is over ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
        h.update(chunk);
        await fh.write(chunk);
      }
      if (head) {
        if (head.length) check!(head);
        size += head.byteLength;
        if (size > maxBytes) throw new ApiError("too_large", `The file is over ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
        h.update(head);
        await fh.write(head);
      }
    } finally { await fh.close(); }
    // a stream that ended early but cleanly (a proxy cut it): never a short file under the real name
    if (expected !== undefined && size !== expected) throw new ApiError("bad_request", `The file arrived incomplete (${size} of ${expected} bytes). Upload it again.`);
    await chmod(temp, FILE_MODE);
    try { await link(temp, path.join(dir, name)); } catch (e) {
      if (exists(e)) throw new ApiError("duplicate", `A file named ${name} is already in this folder. Delete it first.`);
      throw e;
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return { size, sha256: h.digest("hex") };
}

/** Moves `dir/name` out of sight (a dot name the pipeline skips) before a delete; answers the hidden path. */
export async function hideFile(dir: string, name: string): Promise<string> {
  plainName(name);
  const hidden = path.join(dir, `.${Bun.randomUUIDv7()}.deleting`);
  await rename(path.join(dir, name), hidden);
  return hidden;
}

/**
 * Puts a hidden file back under its name (the delete was refused); a file of that name that arrived meanwhile is kept
 * (409 duplicate, the hidden copy stays a leftover the janitor sweeps).
 */
export async function unhideFile(hidden: string, dir: string, name: string): Promise<void> {
  try { await link(hidden, path.join(dir, name)); } catch (e) {
    if (exists(e)) throw new ApiError("duplicate", `A file named ${name} arrived while it was being deleted.`);
    throw e;
  }
  await unlink(hidden);
}

/** Removes a hidden file for good. */
export const dropHidden = (hidden: string): Promise<void> => unlink(hidden);

/** Regular files in `dir` older than `ms` removed; answers how many (a missing folder is none). */
export async function sweepOld(dir: string, ms: number, now = Date.now()): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    const st = await stat(p).catch(() => null);
    if (st && now - st.mtimeMs >= ms) { await unlink(p).catch(() => undefined); n += 1; }
  }
  return n;
}
