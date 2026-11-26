import { crossSite, json, sameOrigin } from "@/lib/server/api";
import { backend, relay } from "@/lib/server/backend";
import { deviceTokens } from "@/lib/server/device";
import { bodyOf, tooLarge } from "@/lib/server/forward";
import { getSession, storeSignIn } from "@/lib/server/session";

/**
 * Sign-in step 1 on a trusted browser (DEC-065): `{ login, next }` goes to `POST /v1/auth/device` with this browser's
 * device tokens (the `sk_device` cookie). A trust of that account → the cookie gets the challenge (marked `device`, so
 * the code page offers no new trust) and the browser `{ next }`; anything else → `{ password: true }`, the full flow.
 */
export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return crossSite();
  const raw = await bodyOf(req);
  if (!raw) return tooLarge();
  let b: { login?: unknown; next?: unknown };
  try {
    b = JSON.parse(await raw.text()) as typeof b;
  } catch {
    b = {};
  }
  const body = JSON.stringify({ login: b.login, next: b.next, tokens: await deviceTokens() });
  const res = await backend("/v1/auth/device", { method: "POST", body, contentType: "application/json", req });
  if (!res.ok) return relay(res);
  const a = (await res.json()) as { next?: string; challenge?: string; password?: true };
  if (!a.challenge || !a.next) return json({ password: true });
  const s = await getSession();
  await storeSignIn(s, { challenge: a.challenge, device: true }, req);
  return json({ next: a.next });
}
