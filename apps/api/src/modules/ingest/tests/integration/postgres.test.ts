// The PostgreSQL connector against a real database (`<test database>_src`, test/helpers/source-db.ts): the connection
// test and its error classes, introspection, keyset pulls across tied timestamps with a microsecond watermark,
// lookback, NULL kept apart from "", the snapshot query with :business_date, and a 1M-row pull with flat memory.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { type Connector, ConnectorError, connectorFor, type Row, type Secret } from "../../connectors";

let src: SQL, secret: Secret;
const open: Connector[] = [];
const pg = (s: Partial<Secret> = {}, o: { connectTimeoutSeconds?: number; statementTimeoutMs?: number } = {}) => {
  const c = connectorFor("postgres", { ...secret, ...s }, { tls: false, connectTimeoutSeconds: o.connectTimeoutSeconds ?? 5, statementTimeoutMs: o.statementTimeoutMs ?? 30_000 });
  open.push(c);
  return c;
};
const fails = async (p: Promise<unknown>) => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(ConnectorError);
  return e as ConnectorError;
};
const all = async (it: AsyncIterable<Row[]>) => { const out: Row[][] = []; for await (const page of it) out.push(page); return out; };

beforeAll(async () => {
  ({ sql: src, secret } = await sourceDb());
  await src.unsafe(`
    drop table if exists ties, kinds, pos;
    create table ties (id bigint generated always as identity primary key, updated_at timestamptz not null, ref text not null, amount numeric(18,2), note text);
    create index on ties (updated_at, id);
    create table kinds (at timestamptz not null, local_at timestamp(3), booked date, n bigint, amount numeric(18,2), ok boolean, label text);
    create table pos (business_date date not null, sid text not null, qty numeric(30,4));
  `);
  // 10 timestamps × 7 rows, 37 µs apart: ties cross every 5-row page
  await src.unsafe(`insert into ties (updated_at, ref, amount, note)
    select timestamptz '2026-11-19 00:00:00+00' + ((g - 1) / 7) * interval '37 microseconds', 'R' || g, g * 100.5, case when g % 3 = 0 then null when g % 3 = 1 then '' else 'n' || g end
    from generate_series(1, 70) g`);
  await src.unsafe(`insert into pos values ('2026-11-02', 'S1', 100.5), ('2026-11-02', 'S2', null), ('2026-11-02', 'S3', 7), ('2026-11-03', 'S1', 1)`);
});
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await src.close();
});

const tiesPull = (c: Connector, after: { wm: string; ids: string[] } | null, chunk = 5, lookbackSeconds = 0) =>
  c.pullWatermark({ from: { table: "public.ties" }, columns: ["ref", "amount", "note"], watermark: { column: "updated_at", id_columns: ["id"] }, after, lookback: { seconds: lookbackSeconds }, chunk });

describe("test()", () => {
  it("passes on a reachable database", async () => {
    await pg().test();
  });

  it("each failure is one class with the driver's code, never its text (host, user)", async () => {
    const login = await fails(pg({ user: "recon_nobody_x" }).test());
    expect([login.kind, login.code]).toEqual(["login", "28000"]);
    expect(login.message).toBe("The server refused the login (28000). Check the user and password.");
    expect(login.message).not.toContain("recon_nobody_x");
    const db = await fails(pg({ database: "recon_no_such_db" }).test());
    expect([db.kind, db.code]).toEqual(["database", "3D000"]);
    expect((await fails(pg({ port: 1 }).test())).kind).toBe("host");
    expect((await fails(pg({ host: "no-such-host.invalid" }).test())).kind).toBe("host");
  });

  it("an unanswered connect is a timeout after the connect timeout", async () => {
    const t0 = performance.now();
    const e = await fails(pg({ host: "10.255.255.1" }, { connectTimeoutSeconds: 1 }).test());
    // two attempts of the connect timeout (retryingConnect): the sentence counts the seconds actually spent
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe(`The server did not answer within ${e.seconds} s.`);
    const spent = performance.now() - t0;
    expect(e.seconds).toBe(Math.max(1, Math.round(spent / 1000)));
    expect(spent).toBeLessThan(4000);
  });

  it("a statement past the statement timeout is a timeout (57014); the session is read-only", async () => {
    const e = await fails(pg({}, { statementTimeoutMs: 300 }).sample({ query: "select pg_sleep(2) as slept" }, ["slept"], 1));
    expect([e.kind, e.code]).toEqual(["timeout", "57014"]);
    // a SELECT that writes: refused by the read-only session (25006), not run
    await src.unsafe("create or replace function recon_write() returns int language sql as $$ insert into pos values ('2000-01-01', 'W', 1) returning 1 $$");
    const w = await fails(pg().sample({ query: "select recon_write() as w" }, ["w"], 1));
    expect([w.kind, w.code]).toEqual(["query", "25006"]);
    expect((await src.unsafe("select count(*)::int as n from pos where sid = 'W'"))[0].n).toBe(0);
  });
});

describe("a SELECT can't lift the read-only session or the statement timeout", () => {
  it("after set_config(…, false) on both, the next statements on the same connector are still refused (25006) and still time out (57014)", async () => {
    const c = pg({}, { statementTimeoutMs: 300 });
    const lift = "select set_config('default_transaction_read_only', 'off', false) as a, set_config('statement_timeout', '0', false) as b";
    expect(await c.sample({ query: lift }, ["a", "b"], 1)).toEqual([{ a: "off", b: "0" }]);
    await src.unsafe("create or replace function recon_write() returns int language sql as $$ insert into pos values ('2000-01-01', 'W', 1) returning 1 $$");
    expect([(await fails(c.sample({ query: "select recon_write() as w" }, ["w"], 1))).code]).toEqual(["25006"]);
    const lifted = await fails(c.sample({ query: "select set_config('transaction_read_only', 'off', false) as x" }, ["x"], 1));
    expect(lifted.kind).toBe("query"); // can't turn a read-only transaction read-write
    expect([(await fails(c.sample({ query: "select pg_sleep(2) as slept" }, ["slept"], 1))).code]).toEqual(["57014"]);
    // a writing CTE wrapped as a subquery is refused before it runs (0A000: not at the top level)
    expect((await fails(c.sample({ query: "with d as (delete from pos returning *) select sid from d" }, ["sid"], 1))).code).toBe("0A000");
    expect((await src.unsafe("select count(*)::int as n from pos"))[0].n).toBe(4);
  });
});

describe("introspect()", () => {
  it("a table: its columns in order with their native type, nullability, unique and indexed", async () => {
    const no = { unique: false, indexed: false };
    expect(await pg().introspect({ table: "kinds" })).toEqual([
      { name: "at", type: "timestamp with time zone", nullable: false, ...no },
      { name: "local_at", type: "timestamp(3) without time zone", nullable: true, ...no },
      { name: "booked", type: "date", nullable: true, ...no },
      { name: "n", type: "bigint", nullable: true, ...no },
      { name: "amount", type: "numeric(18,2)", nullable: true, ...no },
      { name: "ok", type: "boolean", nullable: true, ...no },
      { name: "label", type: "text", nullable: true, ...no },
    ]);
  });

  it("a SELECT: its result columns (nullability unknown); an unknown table or a bad name is a spec error", async () => {
    expect(await pg().introspect({ query: "select sid, qty, business_date from pos" })).toEqual([
      { name: "sid", type: "text", nullable: null, unique: null, indexed: null }, { name: "qty", type: "numeric", nullable: null, unique: null, indexed: null },
      { name: "business_date", type: "date", nullable: null, unique: null, indexed: null },
    ]);
    const none = await fails(pg().introspect({ table: "public.nope" }));
    expect([none.kind, none.message]).toEqual(["spec", "There is no table or view public.nope that this user can read."]);
    expect((await fails(pg().introspect({ table: "x; drop table pos" }))).kind).toBe("spec");
    expect((await fails(pg().introspect({ query: "select 1; drop table pos" }))).kind).toBe("spec");
  });
});

describe("pullWatermark()", () => {
  it("keyset (updated_at, id): 7 rows per tied timestamp across 5-row pages, each row once, in order", async () => {
    const pages = await all(tiesPull(pg(), null));
    expect(pages.map((p) => p.length)).toEqual([...Array(14).fill(5)]);
    const rows = pages.flat();
    expect(rows.map((r) => r.ref)).toEqual(Array.from({ length: 70 }, (_, i) => `R${i + 1}`));
    // the watermark and id ride along as text: microseconds kept (not a JS Date, which stops at ms)
    expect(rows[7]).toEqual({ ref: "R8", amount: "804.00", note: "n8", updated_at: "2026-11-19T00:00:00.000037Z", id: "8" });
    // NULL stays null, "" stays ""
    expect([rows[0]!.note, rows[2]!.note]).toEqual(["", null]);
  });

  it("resumes after a cursor in the middle of a tie: exactly the rows after it", async () => {
    const rows = (await all(tiesPull(pg(), null))).flat();
    const at = rows[32]!; // R33: the 5th of the 7 rows tied at its timestamp
    const rest = (await all(tiesPull(pg(), { wm: at.updated_at!, ids: [at.id!] }, 4))).flat();
    expect(rest.map((r) => r.ref)).toEqual(Array.from({ length: 37 }, (_, i) => `R${i + 34}`));
  });

  it("a microsecond watermark: rows 1 µs later come, the cursor row does not; a millisecond one would pull its ties again", async () => {
    await src.unsafe(`drop table if exists micro; create table micro (id int primary key, updated_at timestamptz not null);
      insert into micro values (1, '2026-11-19 00:00:00.000001+00'), (2, '2026-11-19 00:00:00.000002+00')`);
    const pull = (after: { wm: string; ids: string[] } | null) =>
      all(pg().pullWatermark({ from: { table: "micro" }, columns: ["id"], watermark: { column: "updated_at", id_columns: ["id"] }, after, lookback: { seconds: 0 }, chunk: 10 }));
    const first = (await pull(null)).flat();
    expect(first.map((r) => r.updated_at)).toEqual(["2026-11-19T00:00:00.000001Z", "2026-11-19T00:00:00.000002Z"]);
    expect((await pull({ wm: first[0]!.updated_at!, ids: ["99"] })).flat().map((r) => r.id)).toEqual(["2"]);
    const truncated = new Date(first[0]!.updated_at!).toISOString(); // what toISOString() would carry: 00:00:00.000Z
    expect((await pull({ wm: truncated, ids: ["99"] })).flat().map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("lookback: the first page starts `lookback_seconds` before the watermark, then keyset from there", async () => {
    await src.unsafe(`drop table if exists late; create table late (id int primary key, updated_at timestamptz not null);
      insert into late values (1, '2026-11-19 09:58:00+00'), (2, '2026-11-19 09:59:30+00'), (3, '2026-11-19 10:00:00+00'), (4, '2026-11-19 10:00:00+00'), (5, '2026-11-19 10:00:10+00')`);
    const pull = (lookbackSeconds: number) =>
      all(pg().pullWatermark({ from: { table: "late" }, columns: ["id"], watermark: { column: "updated_at", id_columns: ["id"] }, after: { wm: "2026-11-19T10:00:00.000000Z", ids: ["3"] }, lookback: { seconds: lookbackSeconds }, chunk: 2 }));
    expect((await pull(0)).flat().map((r) => r.id)).toEqual(["4", "5"]);
    expect((await pull(60)).flat().map((r) => r.id)).toEqual(["2", "3", "4", "5"]);
  });

  it("composite id: no column is unique alone, (branch, seq) together are; every row once across 3-row pages and a resume", async () => {
    // 3 timestamps × 6 rows; branch alone and seq alone repeat, (branch, seq) is unique per timestamp
    await src.unsafe(`drop table if exists host; create table host (at timestamp not null, branch text not null, seq int not null, amt int not null);
      insert into host select timestamp '2026-11-19 08:00' + (g / 6) * interval '1 second', 'B' || (g % 2), (g / 2) % 3, g from generate_series(0, 17) g`);
    const pull = (after: { wm: string; ids: string[] | null } | null) =>
      all(pg().pullWatermark({ from: { table: "host" }, columns: ["amt"], watermark: { column: "at", id_columns: ["branch", "seq"] }, after, lookback: { seconds: 0 }, chunk: 4 }));
    const rows = (await pull(null)).flat();
    expect(rows.map((r) => Number(r.amt)).sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    const key = (r: Row) => `${r.at}/${r.branch}/${r.seq}`;
    expect(rows.map(key)).toEqual(rows.map(key).sort());
    // resumed after the 8th row, in the middle of a tie: exactly the 10 after it
    const at = rows[7]!;
    expect((await pull({ wm: at.at!, ids: [at.branch!, at.seq!] })).flat().map((r) => r.amt)).toEqual(rows.slice(8).map((r) => r.amt));
    // ids that no longer fit the id columns (another number of them) resume at the watermark itself
    expect((await pull({ wm: at.at!, ids: null })).flat().map((r) => r.amt)).toEqual(rows.filter((r) => r.at === at.at || r.at! > at.at!).map((r) => r.amt));
  });

  it("rows that repeat the watermark and every id across a page boundary pause the pull (never skipped); repeats inside one page are read", async () => {
    await src.unsafe(`drop table if exists dupk; create table dupk (id int not null, at timestamptz not null, n int not null);
      insert into dupk values (1, '2026-11-19 01:00+00', 1), (2, '2026-11-19 01:00+00', 2), (2, '2026-11-19 01:00+00', 3), (3, '2026-11-19 01:00+00', 4)`);
    const pull = (chunk: number) => all(pg().pullWatermark({ from: { table: "dupk" }, columns: ["n"], watermark: { column: "at", id_columns: ["id"] }, after: null, lookback: { seconds: 0 }, chunk }));
    // 2-row pages: the first ends on one of the two (01:00, 2) rows; `>` after it would skip the other
    const e = await fails(pull(2));
    expect([e.kind, e.message]).toEqual(["spec",
      'More than one row has watermark 2026-11-19T01:00:00.000000Z and id 2 in "at", "id": a pull that stops between them would skip the rest. Pick id columns that are unique together with the watermark.']);
    expect((await pull(3)).flat().map((r) => r.n).sort()).toEqual(["1", "2", "3", "4"]);
  });

  it("a date-only watermark: a row added later on the cursor's date with a smaller id comes in the next pull", async () => {
    await src.unsafe(`drop table if exists daily; create table daily (id int primary key, d date not null);
      insert into daily values (1, '2026-11-19'), (5, '2026-11-20')`);
    const pull = (after: { wm: string; ids: string[] } | null, seconds?: number) =>
      all(pg().pullWatermark({ from: { table: "daily" }, columns: ["id"], watermark: { column: "d", id_columns: ["id"] }, after, lookback: seconds === undefined ? {} : { seconds }, chunk: 10 }));
    const first = (await pull(null)).flat();
    const last = first[first.length - 1]!;
    await src.unsafe("insert into daily values (3, '2026-11-20')");
    expect((await pull({ wm: last.d!, ids: [last.id!] })).flat().map((r) => r.id)).toEqual(["1", "3", "5"]); // default: one day back
    const e = await fails(all(pg().pullWatermark({ from: { table: "daily" }, columns: ["id"], watermark: { column: "d", id_columns: ["id"] }, after: { wm: last.d!, ids: [last.id!] }, lookback: { seconds: 0 }, chunk: 10 })));
    expect([e.kind, e.message]).toEqual(["spec", 'The watermark column "d" holds a date only, so the look back must be at least 1 day (86,400 seconds): a row added later on the same date with a smaller id would be skipped. Rows read again are stored once.']);
  });

  it("an integer watermark past 2^53: keyset exact, the look back a number of ids, never seconds", async () => {
    await src.unsafe(`drop table if exists seqd; create table seqd (seq bigint primary key, ref text not null);
      insert into seqd select 9007199254740990 + g, 'S' || g from generate_series(1, 6) g`);
    const pull = (after: { wm: string; ids: string[] } | null, lookback: { seconds?: number; ids?: number }) =>
      all(pg().pullWatermark({ from: { table: "seqd" }, columns: ["ref"], watermark: { column: "seq", id_columns: ["seq"] }, after, lookback, chunk: 2 }));
    const rows = (await pull(null, {})).flat();
    expect(rows.map((r) => r.seq)).toEqual(["9007199254740991", "9007199254740992", "9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"]);
    expect((await pull({ wm: "9007199254740993", ids: ["9007199254740993"] }, { ids: 0 })).flat().map((r) => r.ref)).toEqual(["S4", "S5", "S6"]);
    expect((await pull({ wm: "9007199254740993", ids: ["9007199254740993"] }, { ids: 2 })).flat().map((r) => r.ref)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    expect((await fails(pull({ wm: "9007199254740993", ids: ["9007199254740993"] }, { seconds: 60 }))).message).toContain("looks back a number of ids");
  });

  it("a uuid id orders as its text on PostgreSQL; a bytea id is refused", async () => {
    await src.unsafe(`drop table if exists uids; create table uids (d date not null, g uuid not null, b bytea not null);
      insert into uids select '2026-11-19', md5(g::text)::uuid, decode(md5(g::text), 'hex') from generate_series(1, 9) g`);
    const rows = (await all(pg().pullWatermark({ from: { table: "uids" }, columns: [], watermark: { column: "d", id_columns: ["g"] }, after: null, lookback: {}, chunk: 4 }))).flat();
    expect(rows.map((r) => r.g)).toEqual(rows.map((r) => r.g!).sort());
    expect(rows).toHaveLength(9);
    const e = await fails(all(pg().pullWatermark({ from: { table: "uids" }, columns: [], watermark: { column: "d", id_columns: ["b"] }, after: null, lookback: {}, chunk: 4 })));
    expect(e.message).toContain("encode(b, 'hex') AS b");
  });

  it("a custom SELECT is pulled as a subquery; a column missing from the source is a spec error", async () => {
    const q = "select id, updated_at, ref from ties where id % 2 = 0";
    const rows = (await all(pg().pullWatermark({ from: { query: q }, columns: ["ref"], watermark: { column: "updated_at", id_columns: ["id"] }, after: null, lookback: { seconds: 0 }, chunk: 8 }))).flat();
    expect(rows.map((r) => r.ref)).toEqual(Array.from({ length: 35 }, (_, i) => `R${(i + 1) * 2}`));
    const e = await fails(all(pg().pullWatermark({ from: { table: "ties" }, columns: ["ref", "gone"], watermark: { column: "updated_at", id_columns: ["id"] }, after: null, lookback: { seconds: 0 }, chunk: 8 })));
    expect([e.kind, e.message]).toEqual(["spec", 'Column "gone" is not in table ties.']);
  });

  it("1,000,000 rows in 10,000-row pages with flat memory", async () => {
    const [{ n }] = await src.unsafe("select count(*)::int as n from pg_tables where tablename = 'big'");
    if (!n || (await src.unsafe("select count(*)::int as n from big"))[0].n !== 1_000_000) {
      await src.unsafe(`drop table if exists big; create table big (id bigint primary key, updated_at timestamptz not null, ref text not null, amount numeric(18,2) not null, account text);
        insert into big select g, timestamptz '2026-11-19 00:00:00+00' + ((g - 1) / 7) * interval '37 microseconds', 'R' || g, g * 1.25, 'ACC' || (g % 5000) from generate_series(1, 1000000) g;
        create index on big (updated_at, id); analyze big`);
    }
    const c = pg();
    Bun.gc(true);
    const mb = (b: number) => Math.round(b / 1048576);
    const rss0 = process.memoryUsage().rss;
    let peak = rss0, count = 0, idSum = 0;
    const heap: number[] = []; // live heap after a full GC, every 100,000 rows: what the pull holds on to
    const t0 = performance.now();
    for await (const page of c.pullWatermark({ from: { table: "big" }, columns: ["ref", "amount", "account"], watermark: { column: "updated_at", id_columns: ["id"] }, after: null, lookback: { seconds: 0 }, chunk: 10_000 })) {
      count += page.length;
      for (const r of page) idSum += Number(r.id);
      peak = Math.max(peak, process.memoryUsage().rss);
      if (count % 100_000 === 0) { Bun.gc(true); heap.push(mb(process.memoryUsage().heapUsed)); }
    }
    const ms = Math.round(performance.now() - t0);
    console.log(JSON.stringify({ pull: "1M rows", ms, rssBaseMb: mb(rss0), rssGrowthMb: mb(peak - rss0), heapAfterGcMb: heap }));
    expect(count).toBe(1_000_000);
    expect(idSum).toBe((1_000_000 * 1_000_001) / 2);
    expect(Math.max(...heap) - Math.min(...heap)).toBeLessThanOrEqual(8); // nothing accumulates page after page
    expect(mb(peak - rss0)).toBeLessThanOrEqual(200); // S7's load-all control grew 489 MB
  }, 180_000);
});

describe("pullSnapshot()", () => {
  it("binds :business_date as a parameter and streams the declared columns in chunks", async () => {
    const pages = await all(pg().pullSnapshot("select sid, qty, business_date from pos where business_date = :business_date order by sid", "2026-11-02", { columns: ["sid", "qty"], chunk: 2 }));
    expect(pages).toEqual([[{ sid: "S1", qty: "100.5000" }, { sid: "S2", qty: null }], [{ sid: "S3", qty: "7.0000" }]]);
    expect((await fails(all(pg().pullSnapshot("select sid from pos where business_date = :business_date", "2026-11-02", { columns: ["qty"], chunk: 2 })))).message)
      .toBe('Column "qty" is not in the query.');
  });
});
