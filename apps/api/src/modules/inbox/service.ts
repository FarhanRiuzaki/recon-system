// The inbox's logic (docs/superpowers/specs/2026-11-25-inbox-files-design.md): a space's folders and files on disk
// (disk.ts), who uploaded what (inbox_uploads), and what the space's published file sources did with each file
// (ingest's source_files). The file system change runs inside the transaction that records its activity entry, so a
// refused change leaves no entry and a failed entry leaves no change behind (an upload removes its file).
import type { Page } from "@starterkit/shared/contracts/common";
import type { InboxFileDto, InboxFileListQuery, InboxFileSourceDto, InboxFolderDto, InboxFolderListDto, InboxState, InboxUploadDto } from "@starterkit/shared/contracts/inbox";
import { INBOX_FOLDER_NAME, INBOX_FOLDERS_MAX, isInboxFileName } from "@starterkit/shared/inbox";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { and, desc, eq, inArray } from "drizzle-orm";
import { realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../../kernel/config";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { sourceFiles } from "../ingest";
import { sources, sourceVersions } from "../sources";
import { spaces, withSpace } from "../spaces";
import { users } from "../users";
import { type DiskFile, dropHidden, ensureRoot, hideFile, listFiles, listFolders, makeFolder, removeFolder, unhideFile, writeUpload } from "./disk";
import { inboxUploads } from "./schema";
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

// ---------------------------------------------------------------- files

const decodeName = (raw: string | null): string => {
  let name: string;
  try { name = decodeURIComponent(raw ?? ""); } catch { throw new ApiError("bad_request", "Send the file name URL-encoded in x-file-name."); }
  if (!isInboxFileName(name)) throw new ApiError("bad_request", "Use a file name without folders, a leading dot or control characters, at most 255 bytes.");
  return name;
};

const cmp = (key: string) => (a: DiskFile, b: DiskFile) => {
  const k = key.replace(/^-/, "") as "name" | "modifiedAt" | "size";
  const d = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0;
  return (key.startsWith("-") ? -d : d) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
};

/** One page of a folder's files (from disk; `q` matches the name in any case), each with its uploader and sources' states. */
export function filePage(ctx: Ctx, folder: string, q: InboxFileListQuery): Promise<Page<InboxFileDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { root } = await rootOf(tx, spaceId);
    const dir = await folderOf(root, folder);
    const needle = q.q?.trim().toLowerCase();
    const all = (await listFiles(dir)).filter((f) => !needle || f.name.toLowerCase().includes(needle)).sort(cmp(q.sort ?? "-modifiedAt"));
    const page = all.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const states = await statesOf(tx, spaceId, await readersOf(tx, spaceId, dir), page);
    const ups = page.length ? await tx.select({ name: inboxUploads.name, size: inboxUploads.size, at: inboxUploads.uploadedAt, userId: users.id, userName: users.name }).from(inboxUploads)
      .leftJoin(users, eq(users.id, inboxUploads.uploadedBy))
      .where(and(eq(inboxUploads.spaceId, spaceId), eq(inboxUploads.folder, folder), inArray(inboxUploads.name, page.map((f) => f.name)))).orderBy(desc(inboxUploads.uploadedAt)) : [];
    const items = page.map((f): InboxFileDto => {
      // the latest upload of that name and size (a file replaced by FTP after an upload no longer matches)
      const u = ups.find((x) => x.name === f.name && x.size === f.size);
      return {
        name: f.name, size: f.size, modifiedAt: new Date(f.modifiedAt).toISOString(),
        uploadedBy: u?.userId ? { id: u.userId, name: u.userName! } : null, uploadedAt: u ? u.at.toISOString() : null,
        sources: states.get(f.name) ?? [],
      };
    });
    return { items, total: all.length, page: q.page, pageSize: q.pageSize };
  });
}

/**
 * Streams the body into the folder (disk.ts writeUpload) outside any transaction (a 100 MB upload outlasts the pool's
 * idle-in-transaction limit), then records the upload and its activity entry in one; if that fails, the file goes.
 */
export async function uploadFile(ctx: Ctx, folder: string, rawName: string | null, length: string | null, body: ReadableStream<Uint8Array> | null): Promise<InboxUploadDto> {
  const { dir, space } = await inSpace(ctx, async (tx, spaceId) => {
    const r = await rootOf(tx, spaceId);
    return { dir: await folderOf(r.root, folder), space: r.space };
  });
  const name = decodeName(rawName);
  const max = config().INBOX_UPLOAD_MAX_MB * 1024 * 1024;
  if (!length || !/^\d+$/.test(length)) throw new ApiError("bad_request", "Send the file's size (Content-Length).");
  if (Number(length) > max) throw new ApiError("bad_request", `The file is over ${config().INBOX_UPLOAD_MAX_MB} MB.`);
  const got = await writeUpload(dir, name, body ?? new Blob([]).stream(), max);
  try {
    await inSpace(ctx, async (tx, spaceId) => {
      await tx.insert(inboxUploads).values({ id: Bun.randomUUIDv7(), spaceId, folder, name, size: got.size, sha256: got.sha256, uploadedBy: ctx.user.id })
        .onConflictDoUpdate({ target: [inboxUploads.spaceId, inboxUploads.folder, inboxUploads.name, inboxUploads.sha256], set: { uploadedBy: ctx.user.id, uploadedAt: new Date() } });
      await recordActivity(tx, ctx, { action: "inbox.upload", target: spaceTarget(space), after: { folder, name, ...got } });
    });
  } catch (e) {
    await unlink(path.join(dir, name)).catch(() => undefined);
    throw e;
  }
  return { name, ...got };
}

/** A listed file of the folder (not a dot file), as a download; 404 otherwise. */
export async function downloadFile(ctx: Ctx, folder: string, name: string): Promise<Response> {
  const file = await inSpace(ctx, async (tx, spaceId) => {
    const { root } = await rootOf(tx, spaceId);
    const dir = await folderOf(root, folder);
    if (!isInboxFileName(name)) throw notFound("file");
    const p = path.join(dir, name);
    if (!(await stat(p).catch(() => null))?.isFile()) throw notFound("file");
    return p;
  });
  return new Response(Bun.file(file).stream(), {
    headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, "Cache-Control": "no-store" },
  });
}

/**
 * Deletes a file no source has read: hidden first (a dot name the pipeline skips, so a scan can't start on it), then
 * checked under the transaction; a source that has read it (any state but waiting) → back under its name, 409.
 */
export async function deleteFile(ctx: Ctx, folder: string, name: string): Promise<void> {
  const { dir, space } = await inSpace(ctx, async (tx, spaceId) => {
    const r = await rootOf(tx, spaceId);
    return { dir: await folderOf(r.root, folder), space: r.space };
  });
  if (!isInboxFileName(name)) throw notFound("file");
  const hidden = await hideFile(dir, name).catch((e) => { throw (e as { code?: string }).code === "ENOENT" ? notFound("file") : e; });
  try {
    await inSpace(ctx, async (tx, spaceId) => {
      const st = await stat(hidden);
      const f = { name, size: st.size, modifiedAt: Math.floor(st.mtimeMs) };
      const states = (await statesOf(tx, spaceId, await readersOf(tx, spaceId, dir), [f])).get(name) ?? [];
      if (states.some((s) => s.state !== "waiting")) throw new ApiError("invalid_state", "A source has already read this file.");
      await recordActivity(tx, ctx, { action: "inbox.file_delete", target: spaceTarget(space), before: { folder, name, size: f.size } });
      await dropHidden(hidden);
    });
  } catch (e) {
    if (await stat(hidden).catch(() => null)) await unhideFile(hidden, dir, name);
    throw e;
  }
}
