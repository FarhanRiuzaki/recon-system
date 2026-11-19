// POST …/connection/test, GET …/connection/columns and the preview of a database source (Task 4) against
// `<test database>_src` (test/helpers/source-db.ts); the file inbox check under INBOX_ROOTS (set by the test preload).
// The stored credential is decrypted server-side only: it never reaches an answer, a log line or an activity entry.
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
const test_ = (token: string, id: string) => call("POST", `${base()}/${id}/connection/test`, { token });
const columns = (token: string | undefined, id: string, table: string) => call("GET", `${base()}/${id}/connection/columns?table=${encodeURIComponent(table)}`, { token });
const draftWith = async (id: string, spec: unknown) => {
  const v = await json<SourceVersionDto>(call("POST", `${base()}/${id}/versions`, { token: t.mk }));
  const r = await call("PATCH", `${base()}/${id}/versions/${v.id}`, { token: t.mk, body: { spec } });
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
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, message: "Connected.", code: null }]);

    expect((await connect(s.id, { user: "recon_nobody_x", password: "Pa55-word-nobody-guesses" })).status).toBe(200);
    const bad = await test_(t.adm, s.id);
    const text = await bad.text();
    expect([bad.status, JSON.parse(text)]).toEqual([200, { ok: false, message: "The server refused the login (28000). Check the user and password.", code: "28000" }]);
    const logged = JSON.stringify(spies.flatMap((x) => x.mock.calls));
    for (const out of [text, logged]) for (const secretBit of ["recon_nobody_x", "Pa55-word-nobody-guesses", secret.host]) expect(out).not.toContain(secretBit);
    const entries = await db.select({ action: activity.action }).from(activity);
    expect(entries.map((e) => e.action)).toEqual(["source.create", "source.connection_set", "source.connection_set"]);
  });

  it("an unreachable host is the host class", async () => {
    const s = await made("db_watermark");
    await connect(s.id, { port: 1 });
    expect(await json(test_(t.adm, s.id))).toEqual({ ok: false, message: "The host could not be reached (ERR_POSTGRES_CONNECTION_REFUSED). Check the host and port, and that this server may connect to it.", code: "ERR_POSTGRES_CONNECTION_REFUSED" });
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
    expect([none.status, (await errOf(none)).message]).toEqual([400, "This source has no folder yet. Save it in a draft first."]);
    const k = ksei();
    const v = await draftWith(s.id, { ...k, input: { ...k.input, path: path.join(root, "ksei") } });
    expect(await json(test_(t.adm, s.id))).toEqual({ ok: true, message: "Folder readable · 3 files match act*.txt", code: null });
    const r = await call("PATCH", `${base()}/${s.id}/versions/${v.id}`, { token: t.mk, body: { spec: { ...k, input: { ...k.input, path: "/etc" } } } });
    expect(r.status).toBe(200);
    const out = await test_(t.adm, s.id);
    expect([out.status, (await errOf(out)).code]).toEqual([400, "bad_request"]);
  });
});

describe("GET …/connection/columns", () => {
  it("the table's columns with native types; an unknown table is 400; a bad name is 400 before the guard", async () => {
    const s = await made("db_watermark");
    await connect(s.id);
    const r = await columns(t.adm, s.id, "public.conn_txn");
    expect([r.status, await r.json()]).toEqual([200, { table: "public.conn_txn", columns: [
      { name: "id", type: "bigint", nullable: false }, { name: "updated_at", type: "timestamp with time zone", nullable: false },
      { name: "ref", type: "text", nullable: true }, { name: "amount", type: "numeric(18,2)", nullable: true }, { name: "note", type: "text", nullable: true },
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
    const v = await draftWith(s.id, { fields, mapping, derive: {}, key_fields: ["ref", "note"], mutable: false, calendar: "id-default",
      input: { kind: "db_watermark", table: "conn_txn", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 60, chunk: 1000 } });
    const p = await json<SourcePreviewDto>(preview(s.id, v.id));
    expect(p).toMatchObject({ lines: 3, ok: 2, quarantined: 1 });
    expect(p.records.map((r) => [r.extRef, r.amountMinor, r.eventTime, r.businessDate, r.attrs.note])).toEqual([
      ["R1", "10050", "2026-11-02T01:00:00.000Z", "2026-11-02", null], ["R2", "700", "2026-11-02T02:00:00.000Z", "2026-11-02", null],
    ]);
    // "" (R1) and NULL (R2) give different natural keys and row hashes
    expect(p.records[0]!.naturalKey).toBe("R1\u001f");
    expect(p.records[1]!.naturalKey).toBe("R2\u001f\u001e");
    expect(p.quarantine).toEqual([{ line: 3, cells: ["", "1.00", "2026-11-02T03:00:00.000000Z", "x"], reasons: { ref: "ref is required" } }]);
    // a sample in the body is for file sources
    expect((await preview(s.id, v.id, { sample: "x" })).status).toBe(400);
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
    const v = await draftWith(s.id, { fields, mapping, derive: {}, key_fields: [], mutable: false, calendar: "id-default",
      input: { kind: "db_watermark", table: "conn_txn", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 0, chunk: 1000 } });
    const r = await preview(s.id, v.id);
    expect([r.status, (await errOf(r)).message]).toEqual([400, "The database was not found (3D000). Check the database name."]);
  });
});
