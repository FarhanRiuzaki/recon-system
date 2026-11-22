// The Bank Mega Open API security profile 2.1: the signature against an independent HMAC (openssl), the wire format
// round trip as the bank reads it (RSA private key → AES key and IV → body → signature), the response, the public key.
import { describe, expect, it } from "bun:test";
import { constants, createDecipheriv, createHash, createHmac, createCipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { openResponse, publicKeyPem, sealRequest, signature, signedPath, timestamp } from "../../profile";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** RSA PKCS#1 v1.5 decryption as the bank does it (the runtime refuses that padding for private decryption). */
export function bankDecrypt(privateKey: string, data: Buffer): Buffer {
  const raw = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, data);
  if (raw[0] !== 0 || raw[1] !== 2) throw new Error("not PKCS#1 v1.5");
  return raw.subarray(raw.indexOf(0, 2) + 1);
}
const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });

describe("signature", () => {
  const i = { method: "POST", path: "/openapi/v2.0/misc/debit-credit", accessToken: "tok", json: '{"a":1}', timestamp: "2026-11-22T03:04:05+00:00", clientSecret: "s3cret" };
  const toSign = `POST:/openapi/v2.0/misc/debit-credit:tok:${sha256hex('{"a":1}')}:2026-11-22T03:04:05+00:00`;
  it("is Base64(HMAC-SHA512(secret, method:path:token:sha256hex(body):timestamp))", () => {
    expect(signature(i)).toBe(createHmac("sha512", "s3cret").update(toSign).digest("base64"));
  });
  it("matches openssl's HMAC of the same string", () => {
    const r = Bun.spawnSync(["sh", "-c", `printf '%s' "$S" | openssl dgst -sha512 -hmac s3cret -binary | base64 | tr -d '\\n'`], { env: { ...process.env, S: toSign } });
    if (r.exitCode !== 0) return; // no openssl on this machine: the HMAC above still pins it
    expect(signature(i)).toBe(r.stdout.toString());
  });
  it("signs the path with its query parts sorted", () => {
    expect(signedPath("/x?b=2&a=1")).toBe("/x?a=1&b=2");
    expect(signedPath("/x")).toBe("/x");
  });
  it("stamps UTC with +00:00 and no milliseconds", () => {
    expect(timestamp(new Date("2026-11-22T03:04:05.678Z"))).toBe("2026-11-22T03:04:05+00:00");
  });
});

describe("the wire format, read as the bank reads it", () => {
  it("the bank recovers the AES key and IV, the body and the signature; it answers in kind", () => {
    const json = JSON.stringify({ Amount: "150000", Remark: "a/b" });
    const s = sealRequest({ method: "POST", path: "/openapi/v2.0/misc/debit-credit?b=2&a=1", json, accessToken: "tok", clientSecret: "s3cret", publicKey: pair.publicKey, now: new Date("2026-11-22T03:04:05Z") });
    const [k64, iv64] = bankDecrypt(pair.privateKey, Buffer.from(s.headers["X-CREDENTIAL-KEY"], "base64")).toString().split(":");
    const key = Buffer.from(k64!, "base64"), iv = Buffer.from(iv64!, "base64");
    expect([key.length, iv.length]).toEqual([32, 16]);
    const d = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([d.update(Buffer.from(s.body, "base64")), d.final()]).toString();
    expect(plain).toBe(json);
    expect(s.headers["X-TIMESTAMP"]).toBe("2026-11-22T03:04:05+00:00");
    expect(s.headers["X-SIGNATURE"]).toBe(signature({ method: "POST", path: "/openapi/v2.0/misc/debit-credit?a=1&b=2", accessToken: "tok", json: plain, timestamp: s.headers["X-TIMESTAMP"], clientSecret: "s3cret" }));
    const c = createCipheriv("aes-256-cbc", key, iv);
    const reply = Buffer.concat([c.update(JSON.stringify({ ResponseCode: "00" })), c.final()]).toString("base64");
    expect(openResponse(reply, s.key, s.iv)).toEqual({ json: { ResponseCode: "00" } });
    expect(openResponse("<html>502</html>", s.key, s.iv)).toEqual({ error: "not_encrypted" });
  });
});

describe("the bank's public key", () => {
  const bare = pair.publicKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  it("takes a PEM, the same key as bare base64, or with Windows line ends", () => {
    const want = publicKeyPem(pair.publicKey);
    expect(publicKeyPem(bare)).toBe(want);
    expect(publicKeyPem(pair.publicKey.replace(/\n/g, "\r\n"))).toBe(want);
  });
  it("refuses something that isn't a key", () => {
    const e = (() => { try { publicKeyPem("hello"); return null; } catch (x) { return x as Error; } })();
    expect(e?.message).toBe("This isn't a public key. Paste the bank's public key (PEM).");
  });
});
