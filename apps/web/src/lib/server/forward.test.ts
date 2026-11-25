import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.INTERNAL_API_TOKEN = "i".repeat(40);
});
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void (value ? jar.set(name, value) : jar.delete(name)),
  }),
}));

import { cookieOf, fakeApi, pathOf, sealCookie, TEST_CSRF, TEST_TOKEN } from "@/test/session";
import { INTERNAL_COPY } from "./backend";
import { forward } from "./forward";
import { log } from "./logger";

const at = (path: string, init: RequestInit = {}) => forward(new Request(`http://c${path}`, init));
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const ok = () => Response.json({ ok: true });

beforeEach(() => jar.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forward (app/api/[...path])", () => {
  it("mutation with a session and no x-csrf-token is 403 csrf and never reaches the API", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      for (const h of [{}, { "x-csrf-token": "wrong" }, { "x-csrf-token": TEST_CSRF.slice(1) + "d" }] as Record<string, string>[]) {
        const r = await at("/api/users", { method, headers: h });
        expect(r.status, `${method} ${JSON.stringify(h)}`).toBe(403);
        expect((await errorOf(r)).code).toBe("csrf");
      }
    }
    expect(seen).toEqual([]);
    expect((await at("/api/users", { method: "POST", headers: { "x-csrf-token": TEST_CSRF } })).status).toBe(200);
    expect((await at("/api/users", { method: "HEAD" })).status).toBe(200); // a read: no token needed
    expect(seen.map((r) => r.method)).toEqual(["POST", "HEAD"]);
  });

  it("GET without a session is forwarded without Authorization", async () => {
    const seen = fakeApi(() => Response.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, { status: 401 }));
    const r = await at("/api/users?page=2&q=a%20b");
    expect(r.status).toBe(401);
    expect(pathOf(seen[0]!)).toBe("/v1/users?page=2&q=a%20b");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(seen[0]!.headers.get("x-internal-token")).toBe(process.env.INTERNAL_API_TOKEN);
    // A mutation without a session has no CSRF token to check: the API answers its 400 or 401.
    expect((await at("/api/users", { method: "POST", body: "{}" })).status).toBe(401);
    expect(seen[1]!.headers.get("authorization")).toBeNull();
  });

  it("forwards the query, the JSON body and the session token", async () => {
    const seen = fakeApi(() => Response.json({ id: "x" }, { status: 201 }));
    await sealCookie(jar);
    const r = await at("/api/roles?x=1", { method: "POST", headers: { "x-csrf-token": TEST_CSRF, "content-type": "application/json" }, body: '{"name":"Ops"}' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ id: "x" });
    const sent = seen[0]!;
    expect([sent.method, pathOf(sent), sent.headers.get("authorization"), sent.headers.get("content-type")])
      .toEqual(["POST", "/v1/roles?x=1", `Bearer ${TEST_TOKEN}`, "application/json"]);
    expect(await sent.text()).toBe('{"name":"Ops"}');
    expect(sent.headers.get("x-csrf-token")).toBeNull(); // the CSRF token stays in Next
  });

  it("browser cookie, authorization, x-internal-token and host never reach the API as sent", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    const sneaky = { cookie: "sk_session=stolen; other=1", authorization: "Bearer someone-else", "x-internal-token": "guessed", host: "evil.example", "x-auth-challenge": "ch" };
    await at("/api/users", { headers: sneaky });
    jar.clear();
    await at("/api/users", { headers: sneaky }); // no session: no bearer at all
    const [withSession, without] = seen;
    for (const r of [withSession!, without!]) {
      expect(r.headers.get("cookie"), "cookie").toBeNull();
      expect(r.headers.get("x-internal-token")).toBe(process.env.INTERNAL_API_TOKEN);
      expect(r.headers.get("x-auth-challenge")).toBeNull();
      expect(new URL(r.url).host).toBe("127.0.0.1:4000");
      expect(r.headers.get("host")).not.toBe("evil.example");
    }
    expect(withSession!.headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(without!.headers.get("authorization")).toBeNull();
  });

  it("API 401 clears the cookie", async () => {
    fakeApi(() => Response.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, { status: 401 }));
    await sealCookie(jar);
    expect((await at("/api/me")).status).toBe(401);
    expect(await cookieOf(jar)).toBeNull();
    // A sign-in waiting for its second factor keeps its cookie (it can still finish or cancel).
    await sealCookie(jar, { challenge: "ch" });
    expect((await at("/api/me")).status).toBe(401);
    expect(await cookieOf(jar)).toEqual({ challenge: "ch" });
  });

  it("`/api/../v1` and `%2e%2e` paths are 404", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    for (const p of ["/api/../v1/users", "/api/%2e%2e/v1/users", "/api/users%2F..%2Fdashboard", "/api/users/a.b",
      "/api/Users", "/api/users/%ZZ", "/api/", "/api/auth/oauth/google/start", "/api/auth/context", "/v1/users"]) {
      const r = await at(p);
      expect(r.status, p).toBe(404);
      expect((await errorOf(r)).code, p).toBe("not_found");
    }
    expect(seen).toEqual([]);
    // A dot segment inside /api/ resolves to the /api/ path it names (WHATWG URL), never above it.
    await at("/api/users/%2E%2E/roles");
    expect(seen.map(pathOf)).toEqual(["/v1/roles"]);
  });

  it("a 70 KB body is 400", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    const big = JSON.stringify({ name: "x".repeat(70 * 1024) });
    for (const headers of [{ "x-csrf-token": TEST_CSRF }, { "x-csrf-token": TEST_CSRF, "content-length": "10" }] as Record<string, string>[]) {
      const r = await at("/api/roles", { method: "POST", headers, body: big });
      expect(r.status).toBe(400);
      expect((await errorOf(r)).code).toBe("bad_request");
    }
    expect(seen).toEqual([]);
    expect((await at("/api/roles", { method: "POST", headers: { "x-csrf-token": TEST_CSRF }, body: "x".repeat(64 * 1024) })).status).toBe(200);
  });

  it("an inbox upload streams through: the same bytes, its length and its name reach the API, past 64 KB", async () => {
    const seen = fakeApi(() => Response.json({ name: "a.txt", size: 2, sha256: "x" }, { status: 201 }));
    await sealCookie(jar);
    const path = "/api/spaces/0193f2a4-1c2b-7d3e-8f40-1a2b3c4d5e6f/inbox/folders/act/files";
    const bytes = "x".repeat(2 * 1024 * 1024);
    const r = await at(path, { method: "POST", headers: { "x-csrf-token": TEST_CSRF, "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-file-name": "Laporan%20ACT.txt" }, body: bytes });
    expect(r.status).toBe(201);
    const sent = seen[0]!;
    expect([pathOf(sent), sent.headers.get("content-length"), sent.headers.get("x-file-name"), sent.headers.get("content-type"), sent.headers.get("authorization")])
      .toEqual([path.replace("/api/", "/v1/"), String(bytes.length), "Laporan%20ACT.txt", "application/octet-stream", `Bearer ${TEST_TOKEN}`]);
    expect((await sent.text()).length).toBe(bytes.length);
  });

  it("an inbox upload needs the CSRF token and its length; another path keeps the 64 KB limit", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    const path = "/api/spaces/0193f2a4-1c2b-7d3e-8f40-1a2b3c4d5e6f/inbox/folders/act/files";
    const big = "x".repeat(2 * 1024 * 1024);
    expect((await errorOf(await at(path, { method: "POST", headers: { "content-length": String(big.length), "x-file-name": "a.txt" }, body: big }))).code).toBe("csrf");
    const noLength = await at(path, { method: "POST", headers: { "x-csrf-token": TEST_CSRF, "x-file-name": "a.txt" }, body: new Blob([big]).stream(), duplex: "half" } as RequestInit);
    expect([noLength.status, (await errorOf(noLength)).code]).toEqual([400, "bad_request"]);
    expect((await at("/api/spaces/0193f2a4-1c2b-7d3e-8f40-1a2b3c4d5e6f/inbox/folders", { method: "POST", headers: { "x-csrf-token": TEST_CSRF }, body: big })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("a picked sample for detection streams like an upload; its JSON form goes as JSON", async () => {
    const seen = fakeApi(() => Response.json({ supported: true }));
    await sealCookie(jar);
    const path = "/api/spaces/0193f2a4-1c2b-7d3e-8f40-1a2b3c4d5e6f/sources/detect";
    const big = "x".repeat(3 * 1024 * 1024);
    expect((await at(path, { method: "POST", headers: { "x-csrf-token": TEST_CSRF, "content-type": "application/octet-stream", "content-length": String(big.length), "x-file-name": "a.xlsx" }, body: big })).status).toBe(200);
    expect([seen[0]!.headers.get("content-type"), seen[0]!.headers.get("x-file-name"), (await seen[0]!.text()).length]).toEqual(["application/octet-stream", "a.xlsx", big.length]);
    const j = JSON.stringify({ inbox: { path: "/data/inbox/msi/act", pattern: "*" } });
    expect((await at(path, { method: "POST", headers: { "x-csrf-token": TEST_CSRF, "content-type": "application/json", "content-length": String(j.length) }, body: j })).status).toBe(200);
    expect([seen[1]!.headers.get("content-type"), await seen[1]!.text()]).toEqual(["application/json", j]);
  });

  it("a source version's spec may be up to 512 KB; above it is 400 and never reaches the API", async () => {
    const seen = fakeApi(ok);
    await sealCookie(jar);
    const id = "01a1f99d-6e49-73e0-b206-c1707b33b8c7";
    const path = `/api/spaces/${id}/sources/${id}/versions/${id}`;
    const send = (p: string, kb: number) => at(p, { method: "PATCH", headers: { "x-csrf-token": TEST_CSRF }, body: JSON.stringify({ x: "y".repeat(kb * 1024) }) });
    expect((await send(path, 140)).status).toBe(200);
    expect((await send(`${path}/preview`, 140)).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect((await send(path, 600)).status).toBe(400);
    expect((await send(`/api/spaces/${id}/sources/${id}`, 70)).status).toBe(400);
    expect(seen).toHaveLength(2);
  });

  it("CSV passes through with Content-Disposition", async () => {
    const csv = "﻿at,actor\n2026-10-20,Admin\n";
    fakeApi(() => new Response(csv, { headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="activity-2026-10-20.csv"',
      "Cache-Control": "no-store", "Set-Cookie": "x=1", "X-Powered-By": "api",
    } }));
    await sealCookie(jar);
    const r = await at("/api/audit/activity?format=csv");
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.clone().arrayBuffer())).toEqual(new TextEncoder().encode(csv));
    expect(Object.fromEntries(r.headers)).toEqual({
      "cache-control": "no-store", "content-disposition": 'attachment; filename="activity-2026-10-20.csv"', "content-type": "text/csv; charset=utf-8",
    });
  });

  it("429 keeps its Retry-After", async () => {
    fakeApi(() => Response.json({ error: { code: "rate_limited", message: "Try again in 40 seconds." } }, { status: 429, headers: { "Retry-After": "40" } }));
    await sealCookie(jar);
    const r = await at("/api/me/password", { method: "POST", headers: { "x-csrf-token": TEST_CSRF }, body: "{}" });
    expect([r.status, r.headers.get("retry-after")]).toEqual([429, "40"]);
  });

  it("API down → 500 internal fixed copy", async () => {
    vi.spyOn(log, "error").mockImplementation(() => undefined);
    fakeApi(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    await sealCookie(jar);
    const r = await at("/api/users");
    expect(r.status).toBe(500);
    expect(await errorOf(r)).toEqual({ code: "internal", message: INTERNAL_COPY });
    expect(await cookieOf(jar)).not.toBeNull();
  });
});
