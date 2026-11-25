// Inbox files: the paths the screen calls and the upload itself (the raw file, streamed by the BFF to the API).
import type { InboxState, InboxUploadDto } from "@starterkit/shared/contracts/inbox";
import { apiFailure, assertApiPath, csrf } from "@/lib/client/api";

/** `/api/spaces/{space}/inbox/folders/{folder}/files`. */
export const inboxFilesPath = (spaceId: string, folder: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/inbox/folders/${encodeURIComponent(folder)}/files` as const;

/** The inbox page of a space, at a folder (`?folder=`) or at its root. */
export const folderHref = (spaceId: string, folder: string | null) =>
  `/spaces/${encodeURIComponent(spaceId)}/inbox${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;

/**
 * Uploads one file into the folder: its bytes as the body, its name URL-encoded in x-file-name, the CSRF token.
 * XMLHttpRequest, not fetch: only it reports upload progress (`onProgress`, 0 to 1). A refusal throws api()'s ApiError.
 */
export function uploadFile(spaceId: string, folder: string, file: File, o: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {}): Promise<InboxUploadDto> {
  const path = inboxFilesPath(spaceId, folder);
  assertApiPath(path);
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", path);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    const token = csrf();
    if (token) x.setRequestHeader("x-csrf-token", token);
    x.upload.onprogress = (e) => { if (e.lengthComputable && e.total) o.onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      const res = new Response(x.responseText || null, { status: x.status, headers: { "content-type": "application/json" } });
      if (x.status >= 200 && x.status < 300) void res.json().then((d) => resolve(d as InboxUploadDto), reject);
      else void apiFailure(res, path).then(reject, reject);
    };
    x.onerror = () => reject(new Error("The upload was cut off. Check the connection and try again."));
    x.onabort = () => reject(new DOMException("The upload was cancelled.", "AbortError"));
    o.signal?.addEventListener("abort", () => x.abort(), { once: true });
    x.send(file);
  });
}

const ORDER: readonly InboxState[] = ["failed", "duplicate", "waiting", "ingested"];
/** A folder's summary as its row shows it: the states that have files, worst first. */
export const stateSummary = (s: Record<InboxState, number>): [InboxState, number][] =>
  ORDER.filter((k) => s[k] > 0).map((k) => [k, s[k]]);
