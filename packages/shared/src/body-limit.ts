// The largest request body, in the web (BFF) and the API alike (AGENTS §3: 64 KB). A source version's spec is the one
// body that grows with its data: 500 columns with long names and their stored names come to about 140 KB (owner,
// 21 Nov: tables of 200+ columns), so saving a version and previewing it take up to SPEC_BODY_MAX; a connector's draft
// (operations with their field trees) too; nothing else does.

export const BODY_MAX = 64 * 1024;
export const SPEC_BODY_MAX = 512 * 1024;

/** PATCH …/sources/{id}/versions/{id} (the draft's spec) and POST …/versions/{id}/preview, as /v1 paths. */
const SPEC_PATH = /^\/v1\/spaces\/[0-9a-f-]{36}\/sources\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}(?:\/preview)?$/i;

/** PATCH …/integrations/connectors/{id}/draft: a connector's operations with their field trees (DEC-053). */
const CONNECTOR_PATH = /^\/v1\/integrations\/connectors\/[0-9a-f-]{36}\/draft$/i;

/** The body limit of the /v1 path `path` (its query left out). */
export const bodyMaxFor = (path: string): number => { const p = path.split("?")[0]!; return SPEC_PATH.test(p) || CONNECTOR_PATH.test(p) ? SPEC_BODY_MAX : BODY_MAX; };

/** POST …/inbox/folders/{folder}/files: an inbox upload, streamed (its limit is INBOX_UPLOAD_MAX_MB, checked by the API). */
const INBOX_UPLOAD_PATH = /^\/v1\/spaces\/[0-9a-fA-F-]{36}\/inbox\/folders\/[a-z0-9][a-z0-9_-]{0,63}\/files$/;

/** Whether the /v1 path `path` (its query left out) is an inbox upload. */
export const isInboxUpload = (path: string): boolean => INBOX_UPLOAD_PATH.test(path.split("?")[0]!);

/** GET …/inbox/folders/{folder}/files/download: a file's bytes, as long as the file is. */
const INBOX_DOWNLOAD_PATH = /^\/v1\/spaces\/[0-9a-fA-F-]{36}\/inbox\/folders\/[a-z0-9][a-z0-9_-]{0,63}\/files\/download$/;

/**
 * The BFF's deadline for a call that moves a whole file (an inbox upload or download): 5 minutes, where every other call
 * keeps its 10 s (null); the deadline also covers streaming the answer's body.
 */
export const inboxDeadlineMs = (method: string, path: string): number | null => {
  const p = path.split("?")[0]!;
  return (method === "POST" && INBOX_UPLOAD_PATH.test(p)) || (method === "GET" && INBOX_DOWNLOAD_PATH.test(p)) ? 300_000 : null;
};
