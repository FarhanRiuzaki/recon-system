// The inbox's logic (docs/superpowers/specs/2026-11-25-inbox-files-design.md): a space's folders and files on disk
// (disk.ts), who uploaded what (inbox_uploads), and what the space's published file sources did with each file
// (ingest's source_files). The file system change runs inside the transaction that records its activity entry, so a
// refused change leaves no entry and a failed entry leaves no change behind (an upload removes its file).
import type { InboxFileSourceDto, InboxFolderDto, InboxFolderListDto, InboxState } from "@starterkit/shared/contracts/inbox";
import { INBOX_FOLDER_NAME, INBOX_FOLDERS_MAX } from "@starterkit/shared/inbox";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { and, eq, inArray } from "drizzle-orm";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../../kernel/config";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { sourceFiles } from "../ingest";
import { sources, sourceVersions } from "../sources";
import { spaces, withSpace } from "../spaces";
import { type DiskFile, ensureRoot, listFolders, makeFolder, removeFolder } from "./disk";
import { spaceRoot, worstState } from "./rules";

const NOT_SET_UP = () => new ApiError("invalid_state", "File inbox isn't set up on this server.");

/** `fn` in a transaction that sees the caller's space (ctx.space, set by the space guard). */
export const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

type Space = { id: string; code: string; name: string };
const spaceOf = async (tx: InTx, spaceId: string): Promise<Space> => {
  const [s] = await tx.select({ id: spaces.id, code: spaces.code, name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId));
  if (!s) throw notFound("space");
  return s;
};
export const spaceTarget = (s: Space) => ({ type: "space", id: s.id, label: s.name });

/** The space's inbox root (made when missing), 409 when the install has no inbox root. */
export async function rootOf(tx: InTx, spaceId: string): Promise<{ space: Space; root: string }> {
  const space = await spaceOf(tx, spaceId);
  const root = spaceRoot(config().INBOX_ROOTS, space.code.toLowerCase());
  if (!root) throw NOT_SET_UP();
  await ensureRoot(root);
  return { space, root };
}

/** A folder of the space root by its name; 404 for a name that isn't a folder name or a folder that isn't there. */
export async function folderOf(root: string, name: string): Promise<string> {
  if (!INBOX_FOLDER_NAME.test(name)) throw notFound("folder");
  const dir = path.join(root, name);
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw notFound("folder");
  return dir;
}

const real = (p: string) => realpath(p).catch(() => path.resolve(p));

export type Reader = { id: string; name: string; pattern: string };
/** The space's published file inbox sources whose folder is `dir` (compared after symlinks are followed). */
export async function readersOf(tx: InTx, spaceId: string, dir: string): Promise<Reader[]> {
  const rows = await tx.select({ id: sources.id, name: sources.name, spec: sourceVersions.spec }).from(sourceVersions)
    .innerJoin(sources, and(eq(sources.spaceId, sourceVersions.spaceId), eq(sources.id, sourceVersions.sourceId)))
    .where(and(eq(sourceVersions.spaceId, spaceId), eq(sourceVersions.status, "published"), eq(sources.kind, "file_inbox")));
  const want = await real(dir);
  const out: Reader[] = [];
  for (const r of rows) {
    const input = (r.spec as SourceSpec | null)?.input;
    if (input?.kind === "file_inbox" && (await real(input.path)) === want) out.push({ id: r.id, name: r.name, pattern: input.pattern });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const STATE: Record<string, InboxState> = { ingested: "ingested", rejected: "duplicate", failed: "failed" };

/** Per file name: each reader whose pattern matches it, with its state for that arrival (name, size, modification time). */
export async function statesOf(tx: InTx, spaceId: string, readers: Reader[], files: DiskFile[]): Promise<Map<string, InboxFileSourceDto[]>> {
  const out = new Map<string, InboxFileSourceDto[]>(files.map((f) => [f.name, []]));
  if (!readers.length || !files.length) return out;
  const rows = await tx.select({ sourceId: sourceFiles.sourceId, name: sourceFiles.name, size: sourceFiles.size, modifiedAt: sourceFiles.modifiedAt, status: sourceFiles.status, rowsOk: sourceFiles.rowsOk, rowsQuarantined: sourceFiles.rowsQuarantined })
    .from(sourceFiles).where(and(eq(sourceFiles.spaceId, spaceId), inArray(sourceFiles.sourceId, readers.map((r) => r.id)), inArray(sourceFiles.name, files.map((f) => f.name))));
  const seen = new Map(rows.map((r) => [`${r.sourceId}|${r.name}|${r.size}|${r.modifiedAt.getTime()}`, r]));
  for (const r of readers) {
    const glob = new Bun.Glob(r.pattern);
    for (const f of files) {
      if (!glob.match(f.name)) continue;
      const row = seen.get(`${r.id}|${f.name}|${f.size}|${f.modifiedAt}`);
      const state = row ? (STATE[row.status] ?? "failed") : "waiting";
      out.get(f.name)!.push({ sourceId: r.id, sourceName: r.name, state, rowsIn: state === "ingested" ? row!.rowsOk : null, rowsQuarantined: state === "ingested" ? row!.rowsQuarantined : null });
    }
  }
  return out;
}

const EMPTY = (): Record<InboxState, number> => ({ waiting: 0, ingested: 0, duplicate: 0, failed: 0 });

async function folderDto(tx: InTx, spaceId: string, root: string, name: string, files: DiskFile[]): Promise<InboxFolderDto> {
  const states = await statesOf(tx, spaceId, await readersOf(tx, spaceId, path.join(root, name)), files);
  const summary = EMPTY();
  for (const list of states.values()) if (list.length) summary[worstState(list.map((s) => s.state))] += 1;
  const newest = files.reduce<DiskFile | null>((a, f) => (!a || f.modifiedAt > a.modifiedAt || (f.modifiedAt === a.modifiedAt && f.name > a.name) ? f : a), null);
  return { name, files: files.length, newest: newest?.name ?? null, newestAt: newest ? new Date(newest.modifiedAt).toISOString() : null, summary };
}

export function folderList(ctx: Ctx): Promise<InboxFolderListDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { root } = await rootOf(tx, spaceId);
    const folders = (await listFolders(root)).slice(0, INBOX_FOLDERS_MAX);
    return { root, folders: await Promise.all(folders.map((f) => folderDto(tx, spaceId, root, f.name, f.files))) };
  });
}

export function createFolder(ctx: Ctx, name: string): Promise<InboxFolderDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { space, root } = await rootOf(tx, spaceId);
    if ((await listFolders(root)).length >= INBOX_FOLDERS_MAX) throw new ApiError("invalid_state", `This space has ${INBOX_FOLDERS_MAX} folders, the most it can have.`);
    await recordActivity(tx, ctx, { action: "inbox.folder_create", target: spaceTarget(space), after: { folder: name } });
    await makeFolder(root, name);
    return folderDto(tx, spaceId, root, name, []);
  });
}

export function deleteFolder(ctx: Ctx, name: string): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { space, root } = await rootOf(tx, spaceId);
    const dir = await folderOf(root, name);
    const [reader] = await readersOf(tx, spaceId, dir);
    if (reader) throw new ApiError("invalid_state", `${reader.name} reads this folder. Change that source first.`);
    await recordActivity(tx, ctx, { action: "inbox.folder_delete", target: spaceTarget(space), before: { folder: name } });
    await removeFolder(root, name);
  });
}
