import "server-only";
import { BODY_MAX, bodyMaxFor } from "@starterkit/shared/body-limit";
import { apiError, csrfFailed } from "./api";
import { backend, relay, v1Path } from "./backend";
import { CSRF_HEADER, csrfOk } from "./csrf";
import { getSession } from "./session";

/**
 * The request body, or null when it is over `max` (the API refuses bigger bodies too, so they never cross: 64 KB, a
 * source version's spec 512 KB, bodyMaxFor); read chunk by chunk, so a huge body is never held whole.
 */
export async function bodyOf(req: Request, max = BODY_MAX): Promise<Blob | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return new Blob(chunks);
}

/** 400 for a body over MAX_BODY (the API's own answer to it). */
export const tooLarge = () => apiError(400, "bad_request", "A request parameter has an unsupported value.");

/**
 * The catch-all `/api/*` route (app/api/[...path]): the browser's request, sent on to the API at `/v1/*`.
 * In order: a path outside v1Path's shape → 404; a full session (token + CSRF) and a mutation without the matching
 * `x-csrf-token` → 403 `csrf`, never forwarded; a body over 64 KB → 400; then method, query and body go to the API with
 * the session token. Without a session the request still goes, without a bearer, so the API decides its 400 or 401.
 * The answer comes back as it is (relay); a 401 for a full session clears the cookie.
 */
export async function forward(req: Request): Promise<Response> {
  const path = v1Path(req.url);
  if (!path) return apiError(404, "not_found", "This page doesn't exist or was deleted.");
  const s = await getSession();
  const token = s.token && s.csrf ? s.token : null;
  const mutation = req.method !== "GET" && req.method !== "HEAD"; // Next answers HEAD with the GET handler
  if (mutation && token && !csrfOk(req.headers.get(CSRF_HEADER), s.csrf)) return csrfFailed();
  const body = mutation ? await bodyOf(req, bodyMaxFor(path)) : null;
  if (mutation && !body) return tooLarge();
  const sent = body?.size ? body : null;
  const res = await backend(path, {
    method: req.method, body: sent, contentType: sent ? (req.headers.get("content-type") ?? "application/json") : undefined, token, req,
  });
  if (res.status === 401 && token) s.destroy();
  return relay(res);
}
