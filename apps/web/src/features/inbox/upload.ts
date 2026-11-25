// Inbox files: the paths the screen calls and the upload itself (the raw file, streamed by the BFF to the API).
import type { InboxState, InboxUploadDto } from "@starterkit/shared/contracts/inbox";
import { api } from "@/lib/client/api";

/** `/api/spaces/{space}/inbox/folders/{folder}/files`. */
export const inboxFilesPath = (spaceId: string, folder: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders/${encodeURIComponent(folder)}/files` as const;

/** The inbox page of a space, at a folder (`?folder=`) or at its root. */
export const folderHref = (spaceId: string, folder: string | null) =>
  `/spaces/${encodeURIComponent(spaceId)}/inbox${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;

/** Uploads one file into the folder: its bytes as the body, its name URL-encoded in x-file-name (api() adds the CSRF token). */
export const uploadFile = (spaceId: string, folder: string, file: File): Promise<InboxUploadDto> =>
  api<InboxUploadDto>(inboxFilesPath(spaceId, folder), {
    method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
  });

const ORDER: readonly InboxState[] = ["failed", "duplicate", "waiting", "ingested"];
/** A folder's summary as its row shows it: the states that have files, worst first. */
export const stateSummary = (s: Record<InboxState, number>): [InboxState, number][] =>
  ORDER.filter((k) => s[k] > 0).map((k) => [k, s[k]]);
