import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createDecipheriv, createHmac } from "node:crypto";
import { loadConfig } from "../../../../kernel/config";
import { log } from "../../../../kernel/log";
import { directory } from "../../ldap";
import { encryptPassword, encryptPasswordGcm, externalId, gatewaySignature, gatewayTimestamp, resetGatewayTokens, verifyPath } from "../../ldap-gateway";

const base = {
  DATABASE_URL: "postgresql://app:pw@localhost:5432/app",
  INTERNAL_API_TOKEN: "t".repeat(40),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const gw = {
  LDAP_GATEWAY_USERNAME: "svc-recon",
  LDAP_GATEWAY_PASSWORD: "svc-password-value",
  LDAP_GATEWAY_CLIENT_ID: "recon-client",
  LDAP_GATEWAY_CLIENT_SECRET: "client-secret-value",
  LDAP_GATEWAY_SECRET_KEY: "aes-secret-key-value",
  LDAP_GATEWAY_PARTNER_ID: "PARTNER1",
  LDAP_GATEWAY_CHANNEL_ID: "95221",
};

function failure(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("loadConfig did not throw");
}

describe("ldap gateway: wire format of the Laravel recon-engine", () => {
  it("encrypts the password as PHP openssl_encrypt AES-256-CBC with a zero IV (key zero-padded or cut to 32 bytes)", () => {
    // Reference values from PHP 8 (the recon-engine image): base64_encode(openssl_encrypt($p, "AES-256-CBC", $k, OPENSSL_RAW_DATA, str_repeat("\0", 16)))
    expect(encryptPassword("Rahasia#2026", "short-key")).toBe("DhlkJHbe830ZhKMN94xqXA==");
    expect(encryptPassword("p@ss wörd/+=", "0123456789abcdef0123456789abcdef-extra")).toBe("8u9RDxK09rTao5SeWD1Z4w==");
  });

  it("signs as PHP hash_hmac sha512 over method:path:token:sha256({}):timestamp", () => {
    const path = "/openapi/v1.0/ldap/verifypassword/userid/12345/password/abc=";
    expect(gatewaySignature({ method: "GET", path, accessToken: "tok-123", timestamp: "2026-11-24T16:30:00+00:00", clientSecret: "client-secret" }))
      .toBe("wB3kovCZgPqVMI2cfw8CsfP2jto6EBtCIYL37J+VxfeYbdnBpYMMv8VKHJ7Y0cgOI3m8kLaoI/VFBe9ImSzC8A==");
  });

  it("timestamp is UTC to the second with +00:00; external id is 20 digits; the login is URI-encoded", () => {
    expect(gatewayTimestamp(new Date("2026-11-24T16:30:00.789Z"))).toBe("2026-11-24T16:30:00+00:00");
    expect(externalId(new Date("2026-11-24T16:30:00Z"))).toMatch(/^\d{6}1795537800\d{4}$/);
    expect(verifyPath("12345", "a+b/c=")).toBe("/openapi/v1.0/ldap/verifypassword/userid/12345/password/a+b/c=");
    expect(verifyPath("a b/c", "x")).toBe("/openapi/v1.0/ldap/verifypassword/userid/a%20b%2Fc/password/x");
  });
});

describe("ldap gateway: config", () => {
  it("needs every credential with LDAP_GATEWAY_URL, names keys only, and refuses LDAP_URL beside it", () => {
    const msg = failure({ ...base, LDAP_GATEWAY_URL: "https://gw.example", LDAP_GATEWAY_PASSWORD: "svc-password-value" });
    for (const k of ["LDAP_GATEWAY_USERNAME", "LDAP_GATEWAY_CLIENT_ID", "LDAP_GATEWAY_CLIENT_SECRET", "LDAP_GATEWAY_SECRET_KEY", "LDAP_GATEWAY_PARTNER_ID", "LDAP_GATEWAY_CHANNEL_ID"]) expect(msg).toContain(k);
    expect(msg).not.toContain("svc-password-value");
    expect(failure({ ...base, ...gw, LDAP_GATEWAY_URL: "ldap://gw.example" })).toContain("LDAP_GATEWAY_URL");
    expect(failure({ ...base, ...gw, LDAP_GATEWAY_URL: "https://gw.example", LDAP_URL: "ldaps://dir:636", LDAP_BASE_DN: "dc=x" })).toContain("not both");
    const c = loadConfig({ ...base, ...gw, LDAP_GATEWAY_URL: "https://gw.example" });
    expect(c.LDAP_GATEWAY_REALM).toBe("quarkus");
    expect(c.LDAP_GATEWAY_INSECURE_TLS).toBe(false);
    expect(directory(c)).not.toBeNull();
  });
});

/** The gateway's side of v0.2: Base64(IV 12 bytes + ciphertext + tag 16 bytes), AES-GCM under the key's UTF-8 bytes. */
function decryptGcm(b64: string, key: string): string {
  const raw = Buffer.from(b64, "base64");
  const k = Buffer.from(key, "utf8");
  const d = createDecipheriv(`aes-${k.length * 8}-gcm` as "aes-256-gcm", k, raw.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}

describe("ldap gateway v0.2 (Technical Specification LDAP API V2.0): AES/GCM/NoPadding", () => {
  const key32 = "k".repeat(31) + "#"; // 32 UTF-8 bytes: AES-256
  it("is Base64 of a random 12-byte IV, the ciphertext and a 16-byte tag, and decrypts with the key to the password", () => {
    const a = encryptPasswordGcm("Rahasia#2026", key32);
    const b = encryptPasswordGcm("Rahasia#2026", key32);
    expect(a).not.toBe(b); // a fresh IV each time
    expect(Buffer.from(a, "base64").length).toBe(12 + Buffer.byteLength("Rahasia#2026") + 16);
    expect(decryptGcm(a, key32)).toBe("Rahasia#2026");
    expect(decryptGcm(encryptPasswordGcm("p@ss wörd/+=", "0123456789abcdef"), "0123456789abcdef")).toBe("p@ss wörd/+="); // 16 bytes: AES-128
  });

  it("config: v0.2 is the only version; its key must be 16, 24 or 32 bytes, named without its value", () => {
    const at = (extra: Record<string, string>) => ({ ...base, ...gw, LDAP_GATEWAY_URL: "https://gw.example", ...extra });
    expect(loadConfig(at({ LDAP_GATEWAY_ENCRYPT_VERSION: "v0.2", LDAP_GATEWAY_SECRET_KEY: key32 })).LDAP_GATEWAY_ENCRYPT_VERSION).toBe("v0.2");
    expect(loadConfig(at({})).LDAP_GATEWAY_ENCRYPT_VERSION).toBeUndefined();
    expect(failure(at({ LDAP_GATEWAY_ENCRYPT_VERSION: "v9" }))).toContain("LDAP_GATEWAY_ENCRYPT_VERSION");
    const msg = failure(at({ LDAP_GATEWAY_ENCRYPT_VERSION: "v0.2", LDAP_GATEWAY_SECRET_KEY: "twenty-byte-key-1234" }));
    expect(msg).toContain("LDAP_GATEWAY_SECRET_KEY (must be 16, 24 or 32 bytes with LDAP_GATEWAY_ENCRYPT_VERSION=v0.2)");
    expect(msg).not.toContain("twenty-byte-key-1234");
  });
});

type Seen = { method: string; path: string; headers: Headers; body: string };

describe("ldap gateway: sign-in against a fake gateway", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: Seen[] = [];
  let tokenCount = 0;
  let verifyCode = "00";
  let refuseToken: string | null = null;
  let hang = false;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = await req.text();
        seen.push({ method: req.method, path: url.pathname, headers: req.headers, body });
        if (hang) await Bun.sleep(2000);
        if (/^\/realms\/[\w.-]+\/protocol\/openid-connect\/token$/.test(url.pathname)) {
          tokenCount += 1;
          return Response.json({ access_token: ` tok-${tokenCount} `, expires_in: 300 });
        }
        if (url.pathname.startsWith("/openapi/v1.0/ldap/verifypassword/")) {
          if (refuseToken && req.headers.get("authorization") === `Bearer ${refuseToken}`) return new Response("", { status: 401 });
          return Response.json({ responseCode: verifyCode, responseMessage: "x" });
        }
        return new Response("", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    seen.length = 0;
    tokenCount = 0;
    verifyCode = "00";
    refuseToken = null;
    hang = false;
    resetGatewayTokens();
  });

  const dir = (extra: Record<string, string> = {}, timeoutMs = 1000) =>
    directory(loadConfig({ ...base, ...gw, LDAP_GATEWAY_URL: `http://127.0.0.1:${server.port}/`, LDAP_GATEWAY_HOST: "openapi.bankmega.test", ...extra }), timeoutMs)!;

  it("takes a password-grant token as the service account, then sends the signed verify call; 00 signs in", async () => {
    expect(await dir().verify("12345", "User#Pass1")).toBe(true);
    const [tok, ver] = seen;
    expect(tok!.method).toBe("POST");
    const form = new URLSearchParams(tok!.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "password", username: "svc-recon", password: "svc-password-value", client_id: "recon-client", client_secret: "client-secret-value" });
    expect(tok!.headers.get("authorization")).toBe(`Basic ${Buffer.from("svc-recon:svc-password-value").toString("base64")}`);
    expect(tok!.headers.get("host")).toBe("openapi.bankmega.test");

    const enc = encryptPassword("User#Pass1", gw.LDAP_GATEWAY_SECRET_KEY);
    expect(ver!.method).toBe("GET");
    expect(ver!.path).toBe(`/openapi/v1.0/ldap/verifypassword/userid/12345/password/${enc}`);
    const h = ver!.headers;
    expect(h.get("authorization")).toBe("Bearer tok-1"); // trimmed
    expect(h.get("host")).toBe("openapi.bankmega.test");
    expect(h.get("x-partner-id")).toBe("PARTNER1");
    expect(h.get("channel-id")).toBe("95221");
    expect(h.get("x-external-id")).toMatch(/^\d{20}$/);
    const ts = h.get("x-timestamp")!;
    expect(ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    const path = `/openapi/v1.0/ldap/verifypassword/userid/12345/password/${enc}`;
    const expected = createHmac("sha512", gw.LDAP_GATEWAY_CLIENT_SECRET)
      .update(`GET:${path}:tok-1:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a:${ts}`).digest("base64");
    expect(h.get("x-signature")).toBe(expected);
  });

  it("v0.2: the token request is the form alone (no Basic header), the password is AES-GCM and X-ENCRYPT-VERSION is sent", async () => {
    const key = "g".repeat(32);
    expect(await dir({ LDAP_GATEWAY_ENCRYPT_VERSION: "v0.2", LDAP_GATEWAY_SECRET_KEY: key, LDAP_GATEWAY_REALM: "quarkus-prod" }).verify("12345", "User#Pass1")).toBe(true);
    const [tok, ver] = seen;
    expect(tok!.path).toBe("/realms/quarkus-prod/protocol/openid-connect/token");
    expect(tok!.headers.get("authorization")).toBeNull();
    expect(new URLSearchParams(tok!.body).get("grant_type")).toBe("password");
    expect(ver!.headers.get("x-encrypt-version")).toBe("v0.2");
    const prefix = "/openapi/v1.0/ldap/verifypassword/userid/12345/password/";
    expect(ver!.path.startsWith(prefix)).toBe(true);
    expect(decryptGcm(ver!.path.slice(prefix.length), key)).toBe("User#Pass1");
    // the signature covers the path as sent
    const ts = ver!.headers.get("x-timestamp")!;
    const expected = createHmac("sha512", gw.LDAP_GATEWAY_CLIENT_SECRET)
      .update(`GET:${ver!.path}:tok-1:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a:${ts}`).digest("base64");
    expect(ver!.headers.get("x-signature")).toBe(expected);
  });

  it("keeps the token between sign-ins, and fetches a new one once when the gateway answers 401", async () => {
    const d = dir();
    expect(await d.verify("12345", "a")).toBe(true);
    expect(await d.verify("12345", "a")).toBe(true);
    expect(tokenCount).toBe(1);
    refuseToken = "tok-1";
    expect(await d.verify("12345", "a")).toBe(true);
    expect(tokenCount).toBe(2);
    expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer tok-2");
  });

  it("any code but 00 is a failed sign-in, logged with the code only, never the login, the password or a token", async () => {
    const warn = spyOn(log, "warn");
    try {
      for (const code of ["96", "99", "94", "90", "XX"]) {
        verifyCode = code;
        expect(await dir().verify("98765", "secret-typed-pass")).toBe(false);
      }
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('"responseCode":"96"');
      expect(logged).toContain("password change required");
      for (const s of ["98765", "secret-typed-pass", "tok-", "svc-password-value", "client-secret-value"]) expect(logged).not.toContain(s);
    } finally {
      warn.mockRestore();
    }
  });

  it("no answer within the timeout is false; an empty password or login never calls the gateway", async () => {
    expect(await dir().verify("12345", "")).toBe(false);
    expect(await dir().verify("", "x")).toBe(false);
    expect(seen.length).toBe(0);
    hang = true;
    const t0 = performance.now();
    expect(await dir({}, 200).verify("12345", "x")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
