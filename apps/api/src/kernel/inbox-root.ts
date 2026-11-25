// A space's inbox root on disk (Inbox files, DEC-057): `<first INBOX_ROOTS entry>/<space code>/`. In the kernel so the
// spaces module makes a new space's root without loading the inbox module (whose service reads sources and ingest).
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/** Folders the app makes: group-writable with the group kept, so a later FTP account of the same group writes there. */
export const INBOX_DIR_MODE = 0o2775;

/** A space's inbox: its code (lower case) under the first inbox root; null when the install has no inbox root. */
export const spaceRoot = (roots: readonly string[], spaceCode: string): string | null =>
  roots[0] ? path.join(path.resolve(roots[0]), spaceCode.toLowerCase()) : null;

/** Makes `dir` (and its parents) with INBOX_DIR_MODE. */
export async function ensureInboxDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: INBOX_DIR_MODE });
  await chmod(dir, INBOX_DIR_MODE);
}

/** Makes the inbox root of the space with code `code`; nothing without an inbox root. */
export async function ensureSpaceRoot(code: string): Promise<void> {
  const root = spaceRoot(config().INBOX_ROOTS, code);
  if (root) await ensureInboxDir(root);
}
