// The security profile `bank_mega_openapi_2_1` (Bank Mega API Security Guides 2.1; wire format as Recon-QR's
// EncryptionService sends it to the bank): per call a random AES-256 key (PBKDF2-SHA256 of the profile phrase, a random
// 16-byte salt, 1000 iterations) and IV; X-CREDENTIAL-KEY = Base64(RSA PKCS#1 v1.5(bank key, base64(key):base64(iv)));
// the body Base64(AES-256-CBC(JSON)); X-SIGNATURE = Base64(HMAC-SHA512(client secret,
// method:path(+sorted query):access token:hex(sha256(JSON)):timestamp)); the answer is AES-256-CBC with the same key
// and IV. Pure (no I/O), node:crypto only.
import { constants, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, pbkdf2Sync, publicEncrypt, randomBytes } from "node:crypto";
import { ApiError } from "../../kernel/errors";

const PHRASE = "itec-cds-is-the-beast";
export const TOKEN_PATH = "/realms/bpsecurity/protocol/openid-connect/token";

/** The bank's public key as PEM: a PEM or its bare base64 (line ends normalized); 400 when it isn't a key. */
export function publicKeyPem(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  const pem = t.includes("-----BEGIN") ? t : `-----BEGIN PUBLIC KEY-----\n${t.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PUBLIC KEY-----`;
  try {
    return createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new ApiError("bad_request", "This isn't a public key. Paste the bank's public key (PEM).");
  }
}

/** The path as signed: its query parts sorted (as the bank sorts them), none when it has no query. */
export function signedPath(path: string): string {
  const at = path.indexOf("?");
  if (at < 0) return path;
  const q = path.slice(at + 1).split("&").filter(Boolean).sort();
  return q.length ? `${path.slice(0, at)}?${q.join("&")}` : path.slice(0, at);
}

/** X-TIMESTAMP: UTC, seconds, with +00:00. */
export const timestamp = (now: Date): string => `${now.toISOString().slice(0, 19)}+00:00`;

export function signature(i: { method: string; path: string; accessToken: string; json: string; timestamp: string; clientSecret: string }): string {
  const digest = createHash("sha256").update(i.json).digest("hex");
  return createHmac("sha512", i.clientSecret).update(`${i.method}:${i.path}:${i.accessToken}:${digest}:${i.timestamp}`).digest("base64");
}

/** A request's encrypted body and its security headers; `key`/`iv` decrypt the answer. */
export function sealRequest(i: { method: string; path: string; json: string; accessToken: string; clientSecret: string; publicKey: string; now: Date }) {
  const key = pbkdf2Sync(PHRASE, randomBytes(16), 1000, 32, "sha256");
  const iv = randomBytes(16);
  const credential = publicEncrypt({ key: i.publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${key.toString("base64")}:${iv.toString("base64")}`));
  const c = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([c.update(i.json, "utf8"), c.final()]).toString("base64");
  const ts = timestamp(i.now);
  return {
    headers: {
      "X-CREDENTIAL-KEY": credential.toString("base64"),
      "X-SIGNATURE": signature({ method: i.method, path: signedPath(i.path), accessToken: i.accessToken, json: i.json, timestamp: ts, clientSecret: i.clientSecret }),
      "X-TIMESTAMP": ts,
    },
    body, key, iv,
  };
}

/** The bank's answer decrypted and parsed; `not_encrypted` when it isn't AES with this key, `bad_json` when it isn't JSON. */
export function openResponse(text: string, key: Buffer, iv: Buffer): { json: unknown } | { error: "not_encrypted" | "bad_json" } {
  let plain: string;
  try {
    const t = text.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return { error: "not_encrypted" };
    const d = createDecipheriv("aes-256-cbc", key, iv);
    plain = Buffer.concat([d.update(Buffer.from(t, "base64")), d.final()]).toString("utf8");
  } catch {
    return { error: "not_encrypted" };
  }
  try { return { json: JSON.parse(plain) }; } catch { return { error: "bad_json" }; }
}
