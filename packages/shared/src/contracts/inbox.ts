import { z } from "zod";
import { INBOX_FOLDER_NAME } from "../inbox";
import { INBOX_FILE_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

export { INBOX_FILE_SORTS };

/** What a source of the space did with a file: no row yet, ingested, refused as a duplicate (same sha256), failed. */
export const INBOX_STATES = ["waiting", "ingested", "duplicate", "failed"] as const;
export const InboxState = z.enum(INBOX_STATES);
export type InboxState = z.infer<typeof InboxState>;

/** One folder of a space's inbox; `summary` counts each file once, by its worst state over the sources that read it. */
export const InboxFolderDto = z.object({
  name: z.string(),
  files: z.number().int(),
  /** The newest file by modification time; null for an empty folder. */
  newest: z.string().nullable(),
  newestAt: z.string().nullable(),
  summary: z.record(InboxState, z.number().int()),
});
export type InboxFolderDto = z.infer<typeof InboxFolderDto>;

/** GET …/inbox/folders: the space root (absolute, for the source wizard's Folder) and its folders by name. */
export const InboxFolderListDto = z.object({ root: z.string(), folders: z.array(InboxFolderDto) });
export type InboxFolderListDto = z.infer<typeof InboxFolderListDto>;

export const CreateInboxFolderBody = z.strictObject({ name: z.string().regex(INBOX_FOLDER_NAME) });
export type CreateInboxFolderBody = z.infer<typeof CreateInboxFolderBody>;

/** One source of the space that reads the folder and whose pattern matches the file, with its state for that file. */
export const InboxFileSourceDto = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  state: InboxState,
  /** Rows taken in and lines quarantined, once ingested; null before. */
  rowsIn: z.number().int().nullable(),
  rowsQuarantined: z.number().int().nullable(),
});
export type InboxFileSourceDto = z.infer<typeof InboxFileSourceDto>;

export const InboxFileDto = z.object({
  name: z.string(),
  size: z.number().int(),
  modifiedAt: z.string(),
  /** Who uploaded it through the app; null for a file that arrived another way (FTP, copied by IT). */
  uploadedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  uploadedAt: z.string().nullable(),
  sources: z.array(InboxFileSourceDto),
});
export type InboxFileDto = z.infer<typeof InboxFileDto>;

/** GET …/inbox/folders/{folder}/files: `q` matches the name (any case). */
export const InboxFileListQuery = ListQuery.extend({ sort: sortParam(INBOX_FILE_SORTS) });
export type InboxFileListQuery = z.infer<typeof InboxFileListQuery>;

/** `?name=` of a file's download and delete (a file name has dots, which a path segment may not). */
export const InboxFileNameQuery = z.strictObject({ name: z.string().min(1).max(1024) });
export type InboxFileNameQuery = z.infer<typeof InboxFileNameQuery>;

/** POST …/files/bulk-delete: up to 100 file names of the folder; answers BulkResult (a skipped name carries its error code). */
export const InboxBulkDeleteBody = z.strictObject({ names: z.array(z.string().min(1).max(1024)).min(1).max(100) });
export type InboxBulkDeleteBody = z.infer<typeof InboxBulkDeleteBody>;

/** POST …/files: the stored file. */
export const InboxUploadDto = z.object({ name: z.string(), size: z.number().int(), sha256: z.string() });
export type InboxUploadDto = z.infer<typeof InboxUploadDto>;
