// The wizard's catalog routes (REC-F2a) against `<test database>_src`: POST …/sources/catalog (a new source's typed
// values) and POST …/{sourceId}/connection/catalog (stored or typed): databases, a page of readable tables, a table's
// columns. Guard source_admin; 60 lists a minute per user apart from the 20 tests; one log line per list without the
// credential; the stored password never goes to other settings; no database typed = the engine's default; the deadline.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { SourceCatalogDto, SourceDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import type { SQL } from "bun";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { db } from "../../../../kernel/db";
import { log } from "../../../../kernel/log";
import { activity } from "../../../audit";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";

let src: SQL, secret: Awaited<ReturnType<typeof sourceDb>>["secret"];
let A: string;
let t: Record<"adm" | "mk" | "ck" | "op", string>;

const base = () => `/v1/spaces/${A}/sources`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const pg = () => ({ engine: "postgres", ...secret });
/** The login IT gave the app: SELECT on some of cat_src only. */
const probeLogin = () => ({ ...pg(), user: "recon_catalog_probe", password: "probe" });
const fresh = (body: unknown, token = t.adm) => call("POST", `${base()}/catalog`, { token, body });
const stored = (id: string, body: unknown, token = t.adm) => call("POST", `${base()}/${id}/connection/catalog`, { token, body });
const dbSource = async (connection: unknown = pg()) => json<SourceDto>(call("POST", base(), { token: t.adm, body: { code: `s-${Bun.randomUUIDv7().slice(-8)}`, name: "S", kind: "db_watermark", connection } }));

beforeAll(async () => {
  ({ sql: src, secret } = await sourceDb());
  await src.unsafe(`
    drop schema if exists cat_src cascade;
    do $$ begin if not exists (select from pg_roles where rolname = 'recon_catalog_probe') then create role recon_catalog_probe login password 'probe'; end if; end $$;
    create schema cat_src;
    create table cat_src.bifast_tx (id bigint primary key, updated_at timestamptz not null, ref text);
    create table cat_src.no_grant (id int);
    create view cat_src.tx_view as select id, ref from cat_src.bifast_tx;
    grant usage on schema cat_src to recon_catalog_probe;
    grant select on cat_src.bifast_tx, cat_src.tx_view to recon_catalog_probe;
  `);
});
afterAll(async () => {
  await src.unsafe("drop schema if exists cat_src cascade");
  await src.close();
});

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "TREASURY" });
  const grant = async (username: string, role: SpaceRole) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    await db.insert(spaceMembers).values({ spaceId: A, userId: u!.id, role });
  };
  await grant("admin", "source_admin");
  await grant("viewer", "config_maker");
  await grant("apple", "config_checker");
  await grant("google", "operator");
  t = { adm: await signIn("admin"), mk: await signIn("viewer"), ck: await signIn("apple"), op: await signIn("google") };
  await db.delete(activity);
});
afterEach(() => (log.info as unknown as { mockRestore?: () => void }).mockRestore?.());

describe("POST …/sources/catalog (a new source's typed values)", () => {
  it("databases the login can open; tables it can SELECT (not cat_src.no_grant) with kind and column count; a table's columns", async () => {
    const dbs = await json<Extract<SourceCatalogDto, { list: "databases" }>>(fresh({ list: "databases", connection: probeLogin() }));
    expect(dbs.items).toContain(secret.database);
    expect(dbs.truncated).toBe(false);
    const tables = await fresh({ list: "tables", connection: probeLogin(), schema: "cat_src" });
    expect([tables.status, await tables.json()]).toEqual([200, {
      list: "tables", items: [{ schema: "cat_src", name: "bifast_tx", kind: "table", columns: 3 }, { schema: "cat_src", name: "tx_view", kind: "view", columns: 2 }],
      total: 2, totalCapped: false, next: null,
    }]);
    const found = await json<Extract<SourceCatalogDto, { list: "tables" }>>(fresh({ list: "tables", connection: probeLogin(), q: "GRANT" }));
    expect(found.items).toEqual([]);
    const cols = await json<Extract<SourceCatalogDto, { list: "columns" }>>(fresh({ list: "columns", connection: probeLogin(), table: "cat_src.bifast_tx" }));
    expect(cols).toEqual({ list: "columns", table: "cat_src.bifast_tx", columns: [
      { name: "id", type: "bigint", nullable: false, unique: true, indexed: true },
      { name: "updated_at", type: "timestamp with time zone", nullable: false, unique: false, indexed: false },
      { name: "ref", type: "text", nullable: true, unique: false, indexed: false },
    ] });
    const hidden = await fresh({ list: "columns", connection: probeLogin(), table: "cat_src.no_grant" });
    expect([hidden.status, (await errOf(hidden)).message]).toEqual([400, "There is no table or view cat_src.no_grant that this user can read."]);
    // nothing stored, nothing recorded
    expect(await db.select({ action: activity.action }).from(activity)).toEqual([]);
  });

  it("no database typed: PostgreSQL lists from `postgres`; tables need a database first; Oracle needs its service name; a password is needed", async () => {
    const dbs = await json<Extract<SourceCatalogDto, { list: "databases" }>>(fresh({ list: "databases", connection: { ...probeLogin(), database: "" } }));
    expect(dbs.items).toContain("postgres");
    const tables = await fresh({ list: "tables", connection: { ...probeLogin(), database: "" } });
    expect([tables.status, (await errOf(tables)).message]).toEqual([400, "Choose the database first: tables are listed per database."]);
    const ora = await fresh({ list: "databases", connection: { ...probeLogin(), engine: "oracle", database: "" } });
    expect([ora.status, (await errOf(ora)).message]).toEqual([400, "Enter the service name: Oracle can't list its services before signing in."]);
    const nopw = await fresh({ list: "databases", connection: { ...probeLogin(), password: undefined } });
    expect([nopw.status, (await errOf(nopw)).message]).toEqual([400, "Enter the password."]);
    expect((await fresh({ list: "databases" })).status).toBe(400);
    expect((await fresh({ list: "tables", connection: probeLogin(), q: "x".repeat(129) })).status).toBe(400);
    expect((await fresh({ list: "columns", connection: probeLogin(), table: "x; drop table t" })).status).toBe(400);
  });

  it("a refused login or database is 400 with the class sentence, never the credential", async () => {
    const r = await fresh({ list: "databases", connection: { ...pg(), user: "recon_nobody_z", password: "Pa55-nobody-z" } });
    const text = await r.text();
    expect([r.status, JSON.parse(text).error.message]).toEqual([400, "The server refused the login (28000). Check the user and password."]);
    for (const bit of ["recon_nobody_z", "Pa55-nobody-z", secret.host]) expect(text).not.toContain(bit);
  });

  it("source_admin only: a config maker, a config checker and an operator are 403, no session 401", async () => {
    for (const token of [t.mk, t.ck, t.op]) expect((await fresh({ list: "databases", connection: probeLogin() }, token)).status).toBe(403);
    expect((await call("POST", `${base()}/catalog`, { body: { list: "databases", connection: probeLogin() } })).status).toBe(401);
  });
});

describe("POST …/{sourceId}/connection/catalog (stored or typed)", () => {
  it("lists over the stored connection; the password left out only for the stored settings unchanged", async () => {
    const s = await dbSource(probeLogin());
    const tables = await json<Extract<SourceCatalogDto, { list: "tables" }>>(stored(s.id, { list: "tables", schema: "cat_src" }));
    expect(tables.items.map((x) => x.name)).toEqual(["bifast_tx", "tx_view"]);
    // the same settings typed without the password: the stored one is used
    const same = await stored(s.id, { list: "tables", schema: "cat_src", connection: { ...probeLogin(), password: undefined } });
    expect(same.status).toBe(200);
    // any setting changed (host, port, database, user, engine): the password must be typed again, for lists and tests
    for (const over of [{ host: "127.0.0.2" }, { port: 1 }, { database: "postgres" }, { user: "postgres" }, { engine: "mysql" }]) {
      const r = await stored(s.id, { list: "databases", connection: { ...probeLogin(), password: undefined, ...over } });
      expect([r.status, (await errOf(r)).message]).toEqual([400, "Type the password again to connect with the changed settings."]);
    }
    const test = await call("POST", `${base()}/${s.id}/connection/test`, { token: t.adm, body: { connection: { ...probeLogin(), password: undefined, host: "127.0.0.2" } } });
    expect([test.status, (await errOf(test)).message]).toEqual([400, "Type the password again to connect with the changed settings."]);
    const sameTest = await json<{ ok: boolean; message: string }>(call("POST", `${base()}/${s.id}/connection/test`, { token: t.adm, body: { connection: { ...probeLogin(), password: undefined } } }));
    expect(sameTest.ok).toBe(true);
    expect(sameTest.message).toContain("as recon_catalog_probe");
  });

  it("no connection yet is 400; a file inbox source is 400; an unknown source 404; source_admin only", async () => {
    const none = await json<SourceDto>(call("POST", base(), { token: t.adm, body: { code: "bare", name: "Bare", kind: "db_watermark" } }));
    const r = await stored(none.id, { list: "databases" });
    expect([r.status, (await errOf(r)).message]).toEqual([400, "This source has no connection yet. Set it first."]);
    const f = await json<SourceDto>(call("POST", base(), { token: t.adm, body: { code: "inbox", name: "Inbox", kind: "file_inbox" } }));
    expect((await stored(f.id, { list: "databases" })).status).toBe(400);
    expect((await stored(Bun.randomUUIDv7(), { list: "databases" })).status).toBe(404);
    for (const token of [t.mk, t.ck, t.op]) expect((await stored(none.id, { list: "databases" }, token)).status).toBe(403);
  });
});

describe("catalog lists are logged and limited apart from the tests", () => {
  it("one log line per list: who, space, engine, host, port, list and result; never the login or password", async () => {
    const info = spyOn(log, "info");
    await fresh({ list: "databases", connection: probeLogin() });
    await fresh({ list: "tables", connection: { ...pg(), user: "recon_nobody_w", password: "Pa55-nobody-w" } });
    const [adm] = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin"));
    expect(info.mock.calls.filter((c) => c[1] === "source catalog list").map((c) => c[0])).toEqual([
      { userId: adm!.id, spaceId: A, engine: "postgres", host: secret.host, port: secret.port, list: "databases", result: "ok" },
      { userId: adm!.id, spaceId: A, engine: "postgres", host: secret.host, port: secret.port, list: "tables", result: "login" },
    ]);
    const logged = JSON.stringify(info.mock.calls);
    for (const bit of ["recon_nobody_w", "Pa55-nobody-w", "recon_catalog_probe", "probe\""]) expect(logged).not.toContain(bit);
  });

  it("the 61st list of a user in a minute is 429 with Retry-After; Test still works (its own 20)", async () => {
    // a list counts once it passes the contract, also one then refused for its values (Oracle without a service name: no connect)
    const cheap = { list: "databases", connection: { ...probeLogin(), engine: "oracle", database: "" } };
    for (let i = 0; i < 60; i++) expect((await fresh(cheap)).status).toBe(400);
    const r = await fresh({ list: "databases", connection: probeLogin() });
    expect([r.status, (await errOf(r)).code]).toEqual([429, "rate_limited"]);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    const test = await call("POST", `${base()}/connection-test`, { token: t.adm, body: { kind: "db_watermark", connection: probeLogin() } });
    expect([test.status, ((await test.json()) as { ok: boolean }).ok]).toEqual([200, true]);
  });

  it("a host that never answers is a timeout within the 8 s deadline", async () => {
    const t0 = performance.now();
    const r = await fresh({ list: "databases", connection: { ...probeLogin(), host: "10.255.255.1", options: { connectTimeoutSeconds: 120 } } });
    const m = /^The server did not answer within (\d+) s\.$/.exec((await errOf(r)).message); // seconds actually spent (two attempts)
    expect([r.status, m !== null, Number(m?.[1]) >= 1 && Number(m?.[1]) <= 8]).toEqual([400, true, true]);
    expect(performance.now() - t0).toBeLessThan(9500);
  }, 15_000);
});
