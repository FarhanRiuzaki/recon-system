// A fake Bank Mega Open API for the integrations tests: TLS with a self-signed certificate (made once per run with
// openssl), the RSA private key whose public key the connector stores, the token endpoint (Basic auth), and operations
// that check the Bearer, decrypt X-CREDENTIAL-KEY and the body, verify X-SIGNATURE and answer encrypted.
import { constants, createCipheriv, createDecipheriv, createHash, createHmac, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** RSA PKCS#1 v1.5 decryption as the bank does it (the runtime refuses that padding for private decryption). */
export function bankDecrypt(privateKey: string, data: Buffer): Buffer {
  const raw = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, data);
  if (raw[0] !== 0 || raw[1] !== 2) throw new Error("not PKCS#1 v1.5");
  return raw.subarray(raw.indexOf(0, 2) + 1);
}

let cert: { cert: string; key: string } | null = null;
function selfSigned() {
  if (cert) return cert;
  const dir = mkdtempSync(join(tmpdir(), "fake-bank-"));
  const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]);
  if (r.exitCode !== 0) throw new Error(`openssl: ${r.stderr.toString()}`);
  cert = { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  return cert;
}

export type FakeBank = { url: string; cert: string; publicKey: string; clientId: string; clientSecret: string; tokens: number; calls: string[]; stop: () => void };

export function fakeBank(o: { clientId?: string; clientSecret?: string } = {}): FakeBank {
  const { cert: crt, key } = selfSigned();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const bank = { clientId: o.clientId ?? "client-1", clientSecret: o.clientSecret ?? "s3cret-value", tokens: 0, calls: [] as string[] };
  const token = "tok-" + Bun.randomUUIDv7();
  const server = Bun.serve({
    port: 0, tls: { cert: crt, key },
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/realms/bpsecurity/protocol/openid-connect/token") {
        bank.tokens++;
        await Bun.sleep(50);
        const want = "Basic " + Buffer.from(`${bank.clientId}:${bank.clientSecret}`).toString("base64");
        if (req.headers.get("authorization") !== want) return Response.json({ error: "unauthorized", echo: req.headers.get("authorization") }, { status: 401 });
        return Response.json({ access_token: token, expires_in: 300 });
      }
      bank.calls.push(u.pathname);
      if (u.pathname === "/html") return new Response("<html>bad gateway</html>", { status: 502 });
      if (u.pathname === "/slow") { await Bun.sleep(3000); return new Response("late"); }
      if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: "bad token" }, { status: 401 });
      const [k64, iv64] = bankDecrypt(pair.privateKey, Buffer.from(req.headers.get("x-credential-key") ?? "", "base64")).toString().split(":");
      const k = Buffer.from(k64!, "base64"), iv = Buffer.from(iv64!, "base64");
      const d = createDecipheriv("aes-256-cbc", k, iv);
      const json = Buffer.concat([d.update(Buffer.from(await req.text(), "base64")), d.final()]).toString();
      const ts = req.headers.get("x-timestamp") ?? "";
      const query = [...u.searchParams.entries()].map(([a, b]) => `${a}=${b}`).sort().join("&");
      const signed = `${req.method}:${u.pathname}${query ? `?${query}` : ""}:${token}:${createHash("sha256").update(json).digest("hex")}:${ts}`;
      if (createHmac("sha512", bank.clientSecret).update(signed).digest("base64") !== req.headers.get("x-signature")) return Response.json({ error: "bad signature" }, { status: 401 });
      const body = JSON.parse(json) as Record<string, unknown>;
      const answer = { ResponseCode: body.fail ? "51" : "00", Ref: "R1", Account: "1234567890", Echo: body, ExternalId: req.headers.get("x-external-id") };
      const c = createCipheriv("aes-256-cbc", k, iv);
      return new Response(Buffer.concat([c.update(JSON.stringify(answer)), c.final()]).toString("base64"));
    },
  });
  return {
    url: `https://localhost:${server.port}`, cert: crt, publicKey: pair.publicKey, ...bank,
    get tokens() { return bank.tokens; }, get calls() { return bank.calls; }, stop: () => void server.stop(true),
  } as FakeBank;
}
