// The first case a bank install meets: a source server whose certificate comes from an internal CA. A throwaway CA and
// server cert are made with openssl into a temp dir (never committed) and a postgres:18 container with ssl=on is started
// on a free port and removed after. Each connect runs in a fresh `bun` process, because the trust bundle
// (NODE_EXTRA_CA_CERTS, docs/recon/deploy.md §5a) is read at process start. Skipped when docker or openssl is missing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sh = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const ok = sh(["docker", "info"]).exitCode === 0 && sh(["openssl", "version"]).exitCode === 0 && sh(["docker", "image", "inspect", "postgres:18"]).exitCode === 0;
const here = import.meta.dir;
const PASSWORD = "tls-test-pw";

let dir = "", name = "", port = 0;

/** Connect (TLS on) in a fresh process; `ca` = the trust bundle to set before it starts, or none. */
async function connect(ca?: string, host = "localhost"): Promise<{ ok: true } | { ok: false; kind: string; code: string | null; tls: { field: string | null; message: string } }> {
  const script = `
    import { connectorFor } from ${JSON.stringify(path.join(here, "../../connectors/index.ts"))};
    import { classify } from ${JSON.stringify(path.join(here, "../../connectors/errors.ts"))};
    import { testFailure } from ${JSON.stringify(path.join(here, "../../../sources/rules.ts"))};
    const c = connectorFor("postgres", { host: ${JSON.stringify(host)}, port: ${port}, database: "postgres", user: "postgres", password: ${JSON.stringify(PASSWORD)} },
      { tls: true, connectTimeoutSeconds: 20, statementTimeoutMs: 10000 });
    try { await c.test(); console.log(JSON.stringify({ ok: true })); }
    catch (e) { const x = classify(e, { connectS: 20, statementS: 10 }); console.log(JSON.stringify({ ok: false, kind: x.kind, code: x.code, tls: testFailure(x, { engine: "postgres", host: ${JSON.stringify(host)}, port: ${port}, user: "postgres", database: "postgres" }, 20) })); }
    await c.close(); process.exit(0);`;
  const env = { ...process.env } as Record<string, string>;
  delete env.NODE_EXTRA_CA_CERTS;
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  const p = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  try { return JSON.parse(out.trim().split("\n").pop()!); } catch { throw new Error(`no result: ${out} ${err}`); }
}

describe.skipIf(!ok)("source database over TLS signed by an internal CA", () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "recon-tls-"));
    writeFileSync(path.join(dir, "san.cnf"), "subjectAltName=DNS:localhost\n");
    const o = (args: string[]) => { const r = sh(["openssl", ...args]); if (r.exitCode) throw new Error(`openssl ${args[0]}: ${r.stderr}`); };
    o(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Test Bank Internal CA", "-keyout", `${dir}/ca.key`, "-out", `${dir}/ca.pem`]);
    o(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", `${dir}/server.key`, "-out", `${dir}/server.csr`]);
    o(["x509", "-req", "-in", `${dir}/server.csr`, "-CA", `${dir}/ca.pem`, "-CAkey", `${dir}/ca.key`, "-CAcreateserial", "-days", "1", "-extfile", `${dir}/san.cnf`, "-out", `${dir}/server.pem`]);
    name = `recon-tls-test-${process.pid}`;
    // The key must belong to postgres with mode 600, so the container copies the mounted certs before starting.
    const start = sh(["docker", "run", "-d", "--name", name, "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-v", `${dir}:/certs:ro`, "--entrypoint", "bash", "postgres:18",
      "-c", "mkdir /tls && cp /certs/server.pem /certs/server.key /tls && chown -R postgres /tls && chmod 600 /tls/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.pem -c ssl_key_file=/tls/server.key"]);
    if (start.exitCode) throw new Error(`docker run: ${start.stderr}`);
    port = Number(/:(\d+)\s*$/m.exec(sh(["docker", "port", name, "5432/tcp"]).stdout.toString())![1]);
    for (let i = 0; i < 60 && sh(["docker", "exec", name, "pg_isready", "-h", "localhost", "-U", "postgres"]).exitCode !== 0; i++) await Bun.sleep(500);
    await Bun.sleep(1000); // the init phase restarts the server once; wait for the final one
    for (let i = 0; i < 60 && sh(["docker", "exec", name, "pg_isready", "-h", "localhost", "-U", "postgres"]).exitCode !== 0; i++) await Bun.sleep(500);
  }, 60_000);
  afterAll(() => {
    if (name) sh(["docker", "rm", "-f", name]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("without the CA in the trust bundle, the test points at the TLS field with the CA sentence", async () => {
    const r = await connect();
    expect(r).toMatchObject({ ok: false, kind: "tls", code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", tls: { field: "tls", message: "The server's certificate isn't trusted by this install. Ask IT to add your bank's CA." } });
  }, 30_000);

  it("a certificate that does not name the typed host says so (Bun gives no certificate name: the fallback sentence)", async () => {
    // the cert's SAN lists only localhost; 127.0.0.1 reaches the same server on any machine (a name such as
    // localhost.localdomain resolves on some hosts only). Bun's error is only "Hostname/IP does not match certificate's altnames"
    const r = await connect(path.join(dir, "ca.pem"), "127.0.0.1");
    expect(r).toMatchObject({ ok: false, kind: "tls", code: "ERR_TLS_CERT_ALTNAME_INVALID", tls: { field: "tls", message: "The certificate doesn't name 127.0.0.1. Use the name on the certificate as Host." } });
  }, 30_000);

  it("with the CA in NODE_EXTRA_CA_CERTS (as deploy.md documents), Connect succeeds", async () => {
    expect(await connect(path.join(dir, "ca.pem"))).toEqual({ ok: true });
  }, 30_000);
});
