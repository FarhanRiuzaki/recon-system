import { crossSite, json, sameOrigin } from "@/lib/server/api";
import { backend, relay } from "@/lib/server/backend";
import { deviceTokens, dropDeviceToken } from "@/lib/server/device";
import { bodyOf, tooLarge } from "@/lib/server/forward";

/**
 * "Forget on this device" (DEC-065): `{ slot, login }` from the sign-in page's list. The token at `slot` goes to
 * `POST /v1/auth/device/forget` with `login`; the API ends the trust only when it is that login's, and only then does
 * the token leave the cookie. `{ forgotten }`.
 */
export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return crossSite();
  const raw = await bodyOf(req);
  if (!raw) return tooLarge();
  let b: { slot?: unknown; login?: unknown };
  try {
    b = JSON.parse(await raw.text()) as typeof b;
  } catch {
    b = {};
  }
  const tokens = await deviceTokens();
  const token = Number.isInteger(b.slot) ? tokens[b.slot as number] : undefined;
  if (!token || typeof b.login !== "string") return json({ forgotten: false });
  const res = await backend("/v1/auth/device/forget", { method: "POST", body: JSON.stringify({ token, login: b.login }), contentType: "application/json", req });
  if (!res.ok) return relay(res);
  const { forgotten } = (await res.json()) as { forgotten: boolean };
  if (forgotten) await dropDeviceToken(b.slot as number);
  return json({ forgotten });
}
