// POST …/connection/test, GET …/connection/columns and the preview of a database source (Task 4) against
// `<test database>_src` (test/helpers/source-db.ts); the file inbox check under INBOX_ROOTS (set by the test preload).
// The stored credential is decrypted server-side only: it never reaches an answer, a log line or an activity entry. Each
// database test logs who tried which engine, host and port and the result kind (never the login or password); a user
// runs at most 20 tests a minute across both test routes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceDto, SourcePreviewDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import type { SQL } from "bun";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { config } from "../../../../kernel/config";
import { db } from "../../../../kernel/db";
import { log } from "../../../../kernel/log";
import { activity } from "../../../audit";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { ksei } from "../spec";

let src: SQL, secret: Awaited<ReturnType<typeof sourceDb>>["secret"];
let A: string;
let t: Record<"adm" | "mk" | "op", string>;

const base = () => `/v1/spaces/${A}/sources`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const errOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const made = async (kind: string, code = kind.replace("_", "-")) => json<SourceDto>(call("POST", base(), { token: t.adm, body: { code, name: code, kind } }));
const connect = (id: string, over: Record<string, unknown> = {}) =>
  call("PUT", `${base()}/${id}/connection`, { token: t.adm, body: { engine: "postgres", ...secret, ...over } });
const test_ = (token: string, id: string, body: unknown = {}) => call("POST", `${base()}/${id}/connection/test`, { token, body });
const columns = (token: string | undefined, id: string, table: string) => call("GET", `${base()}/${id}/connection/columns?table=${encodeURIComponent(table)}`, { token });
const draftWith = async (id: string, spec: unknown) => {
  const v = await json<SourceVersionDto>(call("POST", `${base()}/${id}/versions`, { token: t.mk }));
  const r = await call("PATCH", `${base()}/${id}/versions/${v.id}`, { token: t.adm, body: { spec } }); // how it is read: a source admin's
  expect([r.status, r.status === 200 ? "" : await r.text()]).toEqual([200, ""]);
  return v;
};
const preview = (id: string, v: string, body: unknown = {}) => call("POST", `${base()}/${id}/versions/${v}/preview`, { token: t.mk, body });

beforeAll(async () => {
  ({ sql: src, secret } = await sourceDb());
  await src.unsafe(`drop table if exists conn_txn, conn_pos;
    create table conn_txn (id bigint primary key, updated_at timestamptz not null, ref text, amount numeric(18,2), note text);
    insert into conn_txn values (1, '2026-11-02 01:00:00.000001+00', 'R1', 100.50, ''), (2, '2026-11-02 02:00:00+00', 'R2', 7, null), (3, '2026-11-02 03:00:00+00', null, 1, 'x');
    create table conn_pos (business_date date not null, sid text not null, qty numeric(30,4));
    insert into conn_pos values ('2026-11-02', 'S1', 10), ('2026-11-02', 'S2', 20), ('2026-11-03', 'S1', 11)`);
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
  await grant("apple", "operator");
  t = { adm: await signIn("admin"), mk: await signIn("viewer"), op: await signIn("apple") };
  await db.delete(activity);
});
afterEach(() => {
  for (const k of ["info", "warn", "error", "debug"] as const) (log[k] as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("POST …/connection/test (database)", () => {
  it("connects with the stored credential; a refused login answers its class and code, never the credential; nothing is recorded", async () => {
    const spies = (["info", "warn", "error", "debug"] as const).map((k) => spyOn(log, k));
    const s = await made("db_watermark");
    expect((await connect(s.id)).status).toBe(200);
    const ok = await test_(t.adm, s.id);
    // what it found; a stored connection's login is part of its credential, so the sentence leaves it out
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, message: expect.stringMatching(new RegExp(`^Connected to PostgreSQL \\d+\\.\\d+\\. \\d+ databases; \\d+ tables in ${secret.database}\\.$`)), code: null, field: null, version: expect.stringMatching(/^\d+\.\d+$/) }]);

    expect((await connect(s.id, { user: "recon_nobody_x", password: "Pa55-word-nobody-guesses" })).status).toBe(200);
    const bad = await test_(t.adm, s.id);
    const text = await bad.text();
    expect([bad.status, JSON.parse(text)]).toEqual([200, { ok: false, message: "The server rejected the stored sign-in. Enter the username and password again.", code: "28000", field: "password", version: null }]);
    const logged = JSON.stringify(spies.flatMap((x) => x.mock.calls));
    for (const secretBit of ["recon_nobody_x", "Pa55-word-nobody-guesses", secret.host]) expect(text).not.toContain(secretBit);
    for (const secretBit of ["recon_nobody_x", "Pa55-word-nobody-guesses"]) expect(logged).not.toContain(secretBit); // the host is logged (the probe's target)
    const entries = await db.select({ action: activity.action }).from(activity);
    expect(entries.map((e) => e.action)).toEqual(["source.create", "source.connection_set", "source.connection_set"]);
  });

  it("an unreachable host points at Host; a typed one is named, a stored one isn't (REC-F2b)", async () => {
    const s = await made("db_watermark");
    await connect(s.id, { port: 1 });
    expect(await json(test_(t.adm, s.id))).toEqual({ ok: false, message: "Can't reach the server. Check the host and port.", code: "ERR_POSTGRES_CONNECTION_REFUSED", field: "host", version: null });
    expect(await json(test_(t.adm, s.id, { connection: { engine: "postgres", ...secret, port: 1 } })))
      .toEqual({ ok: false, message: `Can't reach ${secret.host}:1. Check the host and port.`, code: "ERR_POSTGRES_CONNECTION_REFUSED", field: "host", version: null });
  });

  it("source_admin only; no connection yet is 400", async () => {
    const s = await made("db_watermark");
    expect((await test_(t.mk, s.id)).status).toBe(403);
    expect((await test_(t.op, s.id)).status).toBe(403);
    expect((await call("POST", `${base()}/${s.id}/connection/test`)).status).toBe(401);
    const none = await test_(t.adm, s.id);
    expect([none.status, (await errOf(none)).message]).toEqual([400, "This source has no connection yet. Set it first."]);
    expect((await test_(t.adm, Bun.randomUUIDv7())).status).toBe(404);
  });
});

describe("POST …/connection/test (file inbox)", () => {
  it("the folder from the draft spec: readable and the files the pattern matches; outside INBOX_ROOTS is 400", async () => {
    const root = config().INBOX_ROOTS[0]!;
    mkdirSync(path.join(root, "ksei"), { recursive: true });
    for (const f of ["act20261102.txt", "act20261103.txt", "act20261104.txt", "bal20261102.txt"]) writeFileSync(path.join(root, "ksei", f), "x");
    const s = await made("file_inbox");
    const none = await test_(t.adm, s.id);
    expect([none.status, (await errOf(none)).message]).toEqual([400, "This source has no folder yet. Enter the folder and the pattern, then test."]);
    const k = ksei();
    const v = await draftWith(s.id, { ...k, input: { ...k.input, path: path.join(root, "ksei") } });
    expect(await json(test_(t.adm, s.id))).toEqual({ ok: true, message: "Folder readable · 3 files match act*.txt · newest act20261104.txt", code: null, field: null, version: null });
    const r = await call("PATCH", `${base()}/${s.id}/versions/${v.id}`, { token: t.adm, body: { spec: { ...k, input: { ...k.input, path: "/etc" } } } });
    expect(r.status).toBe(200);
    const out = await test_(t.adm, s.id);
    expect([out.status, (await errOf(out)).code]).toEqual([400, "bad_request"]);
  });
});

describe("POST …/connection/test (file inbox, the folder being typed)", () => {
  it("tests the folder and pattern in the body before any spec exists; still inside INBOX_ROOTS after symlinks", async () => {
    const root = config().INBOX_ROOTS[0]!;
    mkdirSync(path.join(root, "typed"), { recursive: true });
    for (const f of ["act20261102.txt", "act20261103.txt", "x.pdf"]) writeFileSync(path.join(root, "typed", f), "x");
    const s = await made("file_inbox");
    expect(await json(test_(t.adm, s.id, { path: path.join(root, "typed"), pattern: "act*.txt" }))).toEqual({ ok: true, message: "Folder readable · 2 files match act*.txt · newest act20261103.txt", code: null, field: null, version: null });
    // the typed folder wins over the draft's
    const k = ksei();
    await draftWith(s.id, { ...k, input: { ...k.input, path: "/nowhere" } });
    expect(await json(test_(t.adm, s.id, { path: path.join(root, "typed"), pattern: "*.pdf" }))).toMatchObject({ ok: true, message: "Folder readable · 1 file matches *.pdf · newest x.pdf" });
    const missing = await json(test_(t.adm, s.id, { path: path.join(root, "absent"), pattern: "*.txt" }));
    expect(missing).toEqual({ ok: false, message: "The folder can't be read (ENOENT). Check that it exists and that this server may read it.", code: null, field: null, version: null });
    // outside the roots: as written, through a dot segment, and through a link inside a root that leads out
    const outside = mkdtempSync(path.join(tmpdir(), "recon-out-"));
    const link = path.join(root, `link-${Date.now()}`);
    symlinkSync(outside, link);
    try {
      for (const p of ["/etc", path.join(root, "..", "x"), link]) {
        const r = await test_(t.adm, s.id, { path: p, pattern: "*" });
        expect([r.status, (await errOf(r)).message]).toEqual([400, "Check input.path: Use a folder inside the inbox folders this install allows."]);
      }
    } finally {
      rmSync(link);
      rmSync(outside, { recursive: true });
    }
    // the folder and the pattern go together; a database source sends neither
    expect((await test_(t.adm, s.id, { path: path.join(root, "typed") })).status).toBe(400);
    const d = await made("db_watermark");
    await connect(d.id);
    expect((await test_(t.adm, d.id, { path: root, pattern: "*" })).status).toBe(400);
    expect((await test_(t.mk, s.id, { path: root, pattern: "*" })).status).toBe(403);
    // a test records nothing
    expect((await db.select({ action: activity.action }).from(activity)).map((e) => e.action).sort())
      .toEqual(["source.connection_set", "source.create", "source.create", "source.version_create", "source.version_update"]);
  });
});

describe("typed values are tested without being stored (fix round 1)", () => {
  it("a stored source tests a typed connection; nothing is stored or recorded, the stored one stays", async () => {
    const s = await made("db_watermark");
    const typed = { engine: "postgres", ...secret };
    expect(await json(test_(t.adm, s.id, { connection: typed }))).toEqual({ ok: true, message: expect.stringMatching(new RegExp(`^Connected to PostgreSQL [\\d.]+ as ${secret.user}\\. \\d+ databases; \\d+ tables in ${secret.database}\\.$`)), code: null, field: null, version: expect.any(String) });
    expect((await json<SourceDto>(call("GET", `${base()}/${s.id}`, { token: t.adm }))).connection).toBeNull();
    expect(await json(test_(t.adm, s.id, { connection: { ...typed, database: "recon_no_such_db" } })))
      .toEqual({ ok: false, message: "Database recon_no_such_db wasn't found. Check the name.", code: "3D000", field: "database", version: null });
    expect((await db.select({ action: activity.action }).from(activity)).map((e) => e.action)).toEqual(["source.create"]);
    // a connection and a folder don't go together; a file source takes no connection
    expect((await test_(t.adm, s.id, { connection: typed, path: "/x", pattern: "*" })).status).toBe(400);
    const f = await made("file_inbox");
    expect((await test_(t.adm, f.id, { connection: typed })).status).toBe(400);
  });

  it("a new source's folder or connection is tried before it exists; source_admin only; nothing is made", async () => {
    const root = config().INBOX_ROOTS[0]!;
    mkdirSync(path.join(root, "fresh"), { recursive: true });
    writeFileSync(path.join(root, "fresh", "act20261102.txt"), "x");
    const tryNew = (token: string, body: unknown) => call("POST", `${base()}/connection-test`, { token, body });
    expect(await json(tryNew(t.adm, { kind: "file_inbox", path: path.join(root, "fresh"), pattern: "act*.txt" }))).toEqual({ ok: true, message: "Folder readable · 1 file matches act*.txt · newest act20261102.txt", code: null, field: null, version: null });
    const out = await tryNew(t.adm, { kind: "file_inbox", path: "/etc", pattern: "*" });
    expect([out.status, (await errOf(out)).message]).toEqual([400, "Check input.path: Use a folder inside the inbox folders this install allows."]);
    expect(await json(tryNew(t.adm, { kind: "db_snapshot", connection: { engine: "postgres", ...secret } }))).toMatchObject({ ok: true, code: null });
    expect((await tryNew(t.adm, { kind: "db_watermark" })).status).toBe(400);
    expect((await tryNew(t.mk, { kind: "file_inbox", path: root, pattern: "*" })).status).toBe(403);
    expect(await db.select({ action: activity.action }).from(activity)).toEqual([]);
    expect((await json<{ total: number }>(call("GET", base(), { token: t.adm }))).total).toBe(0);
  });
});

describe("connection tests are logged and limited per user", () => {
  it("one log line per database test: who, which space, engine, host, port and the result kind; never the login or password", async () => {
    const info = spyOn(log, "info");
    const typed = { engine: "postgres", ...secret, user: "recon_nobody_y", password: "Pa55-word-nobody-guesses-y" };
    expect(await json(call("POST", `${base()}/connection-test`, { token: t.adm, body: { kind: "db_watermark", connection: typed } }))).toEqual({ ok: false, message: "Password rejected for recon_nobody_y.", code: "28000", field: "password", version: null });
    const s = await made("db_watermark");
    await connect(s.id);
    expect(await json(test_(t.adm, s.id))).toMatchObject({ ok: true });
    const [adm] = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin"));
    const lines = info.mock.calls.filter((c) => c[1] === "source connection test").map((c) => c[0]);
    expect(lines).toEqual([
      { userId: adm!.id, spaceId: A, engine: "postgres", host: secret.host, port: secret.port, result: "login" },
      { userId: adm!.id, spaceId: A, engine: "postgres", host: secret.host, port: secret.port, result: "ok" },
    ]);
    const logged = JSON.stringify(info.mock.calls);
    for (const bit of ["recon_nobody_y", "Pa55-word-nobody-guesses-y", secret.user, secret.password, "secretEnc"]) expect(logged).not.toContain(bit);
  });

  it("the 21st test of a user in a minute, on either route, is 429 with Retry-After", async () => {
    const root = config().INBOX_ROOTS[0]!;
    mkdirSync(path.join(root, "limit"), { recursive: true });
    const s = await made("file_inbox");
    const typedFolder = { path: path.join(root, "limit"), pattern: "*.txt" };
    for (let i = 0; i < 10; i++) expect((await test_(t.adm, s.id, typedFolder)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await call("POST", `${base()}/connection-test`, { token: t.adm, body: { kind: "file_inbox", ...typedFolder } })).status).toBe(200);
    for (const r of [await test_(t.adm, s.id, typedFolder), await call("POST", `${base()}/connection-test`, { token: t.adm, body: { kind: "file_inbox", ...typedFolder } })]) {
      expect([r.status, (await errOf(r)).code]).toEqual([429, "rate_limited"]);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });
});

describe("POST …/connection/columns (a SELECT)", () => {
  it("the result columns of the query with :business_date bound, nullability unknown; source_admin only", async () => {
    const s = await made("db_snapshot");
    await connect(s.id);
    const q = (token: string, body: unknown) => call("POST", `${base()}/${s.id}/connection/columns`, { token, body });
    const r = await q(t.adm, { query: "select sid, qty from conn_pos where business_date = :business_date", businessDate: "2026-11-02" });
    expect([r.status, await r.json()]).toMatchObject([200, { table: null, columns: [{ name: "sid", nullable: null }, { name: "qty", nullable: null }] }]);
    const twice = await q(t.adm, { query: "select sid, sid from conn_pos" });
    expect([twice.status, (await errOf(twice)).message]).toEqual([400, 'The query returns column "sid" twice. Give each column its own name.']);
    expect((await q(t.mk, { query: "select 1" })).status).toBe(403);
    expect((await q(t.adm, { query: "" })).status).toBe(400);
    const f = await made("file_inbox");
    expect((await call("POST", `${base()}/${f.id}/connection/columns`, { token: t.adm, body: { query: "select 1" } })).status).toBe(400);
    expect(await db.select({ action: activity.action }).from(activity).where(eq(activity.action, "source.version_update"))).toEqual([]);
  });
});

describe("GET …/connection/columns", () => {
  it("the table's columns with native types, unique and indexed; an unknown table is 400; a bad name is 400 before the guard", async () => {
    const plain = { unique: false, indexed: false };
    const s = await made("db_watermark");
    await connect(s.id);
    const r = await columns(t.adm, s.id, "public.conn_txn");
    expect([r.status, await r.json()]).toEqual([200, { table: "public.conn_txn", columns: [
      { name: "id", type: "bigint", nullable: false, unique: true, indexed: true }, { name: "updated_at", type: "timestamp with time zone", nullable: false, ...plain },
      { name: "ref", type: "text", nullable: true, ...plain }, { name: "amount", type: "numeric(18,2)", nullable: true, ...plain }, { name: "note", type: "text", nullable: true, ...plain },
    ] }]);
    const none = await columns(t.adm, s.id, "nope");
    expect([none.status, (await errOf(none)).message]).toEqual([400, "There is no table or view nope that this user can read."]);
    expect((await columns(undefined, s.id, "x;drop table users")).status).toBe(400);
    expect((await columns(undefined, s.id, "a.b.c")).status).toBe(400);
    expect((await columns(t.mk, s.id, "conn_txn")).status).toBe(403);
  });
});

describe("preview of a database source", () => {
  const fields = [
    { name: "ref", type: "string", nullable: false, trim: true },
    { name: "amount", type: "decimal", nullable: true, trim: true, format: { scale: 2 } },
    { name: "updated_at", type: "datetime", nullable: false, trim: true },
    { name: "note", type: "string", nullable: true, trim: false },
  ];
  const mapping = { business_date: { field: "updated_at" }, amount_minor: { field: "amount" }, ext_ref: { field: "ref" }, event_time: { field: "updated_at" }, attrs: { note: { field: "note" } } };

  it("a watermark source pulls a sample (watermark predicate omitted) through the mapping: NULL is null, not \"\"", async () => {
    const s = await made("db_watermark");
    await connect(s.id);
    const v = await draftWith(s.id, { fields, mapping, derive: {}, key_fields: ["ref"], mutable: false, calendar: "id-default", currency: "IDR",
      input: { kind: "db_watermark", table: "conn_txn", watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 60, chunk: 1000 } });
    const p = await json<SourcePreviewDto>(preview(s.id, v.id));
    expect(p).toMatchObject({ lines: 3, ok: 2, quarantined: 1 });
    expect(p.records.map((r) => [r.extRef, r.amountMinor, r.eventTime, r.businessDate, r.attrs.note])).toEqual([
      ["R1", "10050", "2026-11-02T01:00:00.000Z", "2026-11-02", null], ["R2", "700", "2026-11-02T02:00:00.000Z", "2026-11-02", null],
    ]);
    expect(p.records.map((r) => r.naturalKey)).toEqual(["R1", "R2"]);
    expect(p.quarantine).toEqual([{ line: 3, cells: ["", "1.00", "2026-11-02T03:00:00.000000Z", "x"], reasons: { ref: "ref is required" } }]);
    // a sample in the body is for file sources
    expect((await preview(s.id, v.id, { sample: "x" })).status).toBe(400);
  });

  it("the look back is checked against the watermark column's type: a date one day at least, an integer in ids", async () => {
    const s = await made("db_watermark");
    await connect(s.id);
    const query = "select id, updated_at, updated_at::date as d, ref, amount, note from conn_txn";
    const spec = (input: Record<string, unknown>) => ({ fields, mapping, derive: {}, key_fields: ["ref"], mutable: false, calendar: "id-default", currency: "IDR",
      input: { kind: "db_watermark", query, chunk: 1000, ...input } });
    const v = await draftWith(s.id, spec({ watermark: { column: "d", id_columns: ["id"] }, lookback_seconds: 3600 }));
    const r = await preview(s.id, v.id);
    expect([r.status, (await errOf(r)).message]).toEqual([400,
      'Check input.lookback_seconds: The watermark column "d" holds a date only, so the look back must be at least 1 day (86,400 seconds): a row added later on the same date with a smaller id would be skipped. Rows read again are stored once.']);
    const set = async (input: Record<string, unknown>) => expect((await call("PATCH", `${base()}/${s.id}/versions/${v.id}`, { token: t.adm, body: { spec: spec(input) } })).status).toBe(200);
    await set({ watermark: { column: "d", id_columns: ["id"] }, lookback_seconds: 86_400 });
    expect((await preview(s.id, v.id)).status).toBe(200);
    await set({ watermark: { column: "id", id_columns: ["id"] }, lookback_seconds: 60 });
    expect((await errOf(await preview(s.id, v.id))).message).toBe('Check input.lookback_seconds: The watermark column "id" is an integer (a sequence), so it looks back a number of ids, not seconds.');
    await set({ watermark: { column: "id", id_columns: ["id"] }, lookback_ids: 1000 });
    expect((await preview(s.id, v.id)).status).toBe(200);
  });

  it("a snapshot source pulls the query for the business date in the body", async () => {
    const s = await made("db_snapshot");
    await connect(s.id);
    const v = await draftWith(s.id, {
      fields: [{ name: "sid", type: "string", nullable: false, trim: true }, { name: "qty", type: "decimal", nullable: true, trim: true, format: { scale: 4 } }],
      mapping: { business_date: { cel: '"2026-11-02"' }, account_ref: { field: "sid" }, attrs: { qty: { field: "qty" } } }, derive: {}, key_fields: ["sid"], mutable: false, calendar: "id-default",
      input: { kind: "db_snapshot", query: "select sid, qty from conn_pos where business_date = :business_date order by sid", schedule: "0 6 * * *" },
    });
    const p = await json<SourcePreviewDto>(preview(s.id, v.id, { businessDate: "2026-11-02" }));
    expect(p.records.map((r) => [r.accountRef, r.attrs.qty])).toEqual([["S1", "10.0000"], ["S2", "20.0000"]]);
    for (const businessDate of ["2026-13-40", "2026-02-30", "02/11/2026"]) expect((await preview(s.id, v.id, { businessDate })).status).toBe(400);
  });

  it("a connection that fails answers 400 with its class message", async () => {
    const s = await made("db_watermark");
    await connect(s.id, { database: "recon_no_such_db" });
    const v = await draftWith(s.id, { fields, mapping, derive: {}, key_fields: [], mutable: false, calendar: "id-default", currency: "IDR",
      input: { kind: "db_watermark", table: "conn_txn", watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 0, chunk: 1000 } });
    const r = await preview(s.id, v.id);
    expect([r.status, (await errOf(r)).message]).toEqual([400, "The database was not found (3D000). Check the database name."]);
  });
});
