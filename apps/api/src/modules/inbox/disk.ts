// The inbox's files on disk: the one place the inbox module touches the file system, so a later object store
// (MinIO or another S3, owner 25 Nov) replaces this file without changing routes or screens. Callers pass a space root
// or a folder already resolved inside the inbox roots (service.ts, through ingest's inboxFolder). An upload is written
// as a dot file and linked to its name only when whole; the file_inbox pipeline never reads a dot file.
import { INBOX_FOLDER_NAME, isInboxFileName } from "@starterkit/shared/inbox";
import { chmod, link, mkdir, open, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../kernel/errors";

/** Folders the app makes: group-writable with the group kept, so a later FTP account of the same group writes there. */
const DIR_MODE = 0o2775;
const FILE_MODE = 0o664;

export type DiskFile = { name: string; size: number; modifiedAt: number };
export type DiskFolder = { name: string; files: DiskFile[] };

const plainName = (name: string) => { if (!isInboxFileName(name)) throw new ApiError("bad_request", "Use a file name without folders, a leading dot or control characters, at most 255 bytes."); };
const folderName = (name: string) => { if (!INBOX_FOLDER_NAME.test(name)) throw new ApiError("bad_request", "Use lower case letters, digits, _ and - for a folder name, starting with a letter or digit."); };
const exists = (e: unknown) => (e as { code?: string }).code === "EEXIST";

export async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: DIR_MODE });
  await chmod(root, DIR_MODE);
}

/** The regular, non-dot files of `dir`, by name. */
export async function listFiles(dir: string): Promise<DiskFile[]> {
  const out: DiskFile[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const st = await stat(path.join(dir, e.name));
    out.push({ name: e.name, size: st.size, modifiedAt: Math.floor(st.mtimeMs) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

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
  try { await rmdir(path.join(root, name)); } catch (e) {
    if (["ENOTEMPTY", "EEXIST"].includes((e as { code?: string }).code ?? "")) throw new ApiError("invalid_state", "Delete the files in this folder first.");
    throw e;
  }
}

/**
 * Writes `body` to `dir/name`: first to a dot file of its own (`.<random>.uploading`), hashing while it writes;
 * over `maxBytes` or a broken stream → the dot file is removed and nothing lands; then linked to `name` (refused when
 * that name exists: 409 duplicate, never overwritten) and the dot file removed.
 */
export async function writeUpload(dir: string, name: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ size: number; sha256: string }> {
  plainName(name);
  // the temporary name doesn't carry the file's: a 255-byte name would pass the file system's limit with it
  const temp = path.join(dir, `.${Bun.randomUUIDv7()}.uploading`);
  const h = new Bun.CryptoHasher("sha256");
  let size = 0;
  const fh = await open(temp, "wx", FILE_MODE);
  try {
    try {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new ApiError("bad_request", `The file is over ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
        h.update(chunk);
        await fh.write(chunk);
      }
    } finally { await fh.close(); }
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

/** Puts a hidden file back under its name (the delete was refused). */
export async function unhideFile(hidden: string, dir: string, name: string): Promise<void> {
  await rename(hidden, path.join(dir, name));
}

/** Removes a hidden file for good. */
export const dropHidden = (hidden: string): Promise<void> => unlink(hidden);
