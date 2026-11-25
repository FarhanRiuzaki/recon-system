import { Elysia } from "elysia";
import { ApiError } from "../errors";
import { isInboxUpload } from "@starterkit/shared/body-limit";
import { bodyMaxFor } from "../parse";

/**
 * Request bodies over 64 KB (an inbox upload aside: streamed to disk, its limit INBOX_UPLOAD_MAX_MB in the inbox module) (a source version's spec: 512 KB, bodyMaxFor) are 400 bad_request. A declared Content-Length is checked when the request arrives (before
 * the token); a body without one is counted while `body()` reads it in the handler, after the guard. Elysia never
 * parses a body (onParse answers null), so a malformed body is the handler's 400, never earlier.
 */
export const bodyLimit = new Elysia({ name: "kernel.body-limit" })
  .onRequest(({ request }) => {
    const p = new URL(request.url).pathname;
    // an inbox upload streams to disk; its own limit (INBOX_UPLOAD_MAX_MB) is checked by the inbox module
    if (request.method === "POST" && isInboxUpload(p)) return;
    if (Number(request.headers.get("content-length") ?? 0) > bodyMaxFor(p)) throw new ApiError("bad_request");
  })
  .onParse({ as: "global" }, () => null);
