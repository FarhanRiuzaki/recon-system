// The ingest pipeline end to end, every handler run as the app role (appRoleDb: row level security on, as the worker's
// workerDb), against files in the test inbox and tables in `<test database>_src`:
// - KSEI ACT two days (docs/recon/ksei-sample-data.md): file inbox and Medallion snapshot, counts and quarantine.
// - Review Focus 1–5 (plan 2): a resent file, a snapshot failing halfway, tied timestamps and late commits, a source
//   whose columns changed, and space isolation through the handlers.
// - Carry-overs: a repeated page before "did not move", a nullable watermark, mutable versions, partitions.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SQL } from "bun";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, count, eq } from "drizzle-orm";
import { DEFAULTS, synthPair } from "../../../../../scripts/spikes/synth";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { partitionsOf, truncateAll } from "../../../../../test/helpers/db";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { encryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { calendars, sourceConnections, sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { type Connector, ConnectorError, type Row, type Secret } from "../../connectors";
import { quarantineRows, records, sourceCursors, sourceFiles, sourceSnapshots } from "../../schema";
import { currentRecord, ensureIngestPartitions, ingestFile, ingestHooks, type InboxFile, pullSource, scanSource, snapshotSource } from "../../service";
import { KSEI_FILE, ksei } from "../unit/fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
type Src = { spaceId: string; sourceId: string; versionId: string };

let probe: Probe, src: SQL, secret: Secret;
const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
const DIR = path.join(ROOT, `pipeline-${Bun.randomUUIDv7()}`);
const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7();
const D = "2026-11-02", D1 = "2026-11-03";
const LATER = () => Date.now() + 61_000; // past the 60 s a file must stay unchanged
const defaultHooks = { ...ingestHooks };

const sid = (n: number) => `TSTSID0000000${String(n).padStart(2, "0")}`;
const kseiLine = (n: number) => ["A1", "B1", `TSTSRE${String(n).padStart(3, "0")}`, "D4", "E5", "F6", "G7", "H8", "I9", "J10", "K11", "L12", sid(n), "N14"].join("|");

/** A source of `spaceId` with version 1 published (and a connection to `<test>_src` for a database source). */
async function source(spaceId: string, spec: SourceSpec): Promise<Src> {
  const sourceId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  await db.insert(sources).values({ id: sourceId, spaceId, code: `s-${sourceId.slice(-12)}`, name: "S", kind: spec.input.kind });
  await db.insert(sourceVersions).values({ id: versionId, spaceId, sourceId, version: 1, status: "published", spec, specHash: "h", makerId: A, publishedAt: new Date() });
  if (spec.input.kind !== "file_inbox") {
    await db.insert(sourceConnections).values({ spaceId, sourceId, engine: "postgres", secretEnc: encryptSecret(JSON.stringify(secret)), options: { tls: false, connectTimeoutSeconds: 5 } });
  }
  return { spaceId, sourceId, versionId };
}
const scope = (s: Src) => ({ spaceId: s.spaceId, sourceId: s.sourceId });
const kseiSpec = (o: Partial<SourceSpec["input"]> = {}): SourceSpec => ({ ...ksei(), input: { ...(ksei().input as object), path: DIR, ...o } as SourceSpec["input"] });

/** Current records of `s` (a snapshot's while it is active, a mutable row's latest), counted by the superuser. */
const current = async (s: Src, date?: string) => (await db.transaction((tx) => tx.select({ n: count() }).from(records)
  .where(and(eq(records.sourceId, s.sourceId), date ? eq(records.businessDate, date) : undefined, currentRecord(tx)))))[0]!.n;
const allRecords = async (s: Src) => (await db.select({ n: count() }).from(records).where(eq(records.sourceId, s.sourceId)))[0]!.n;
const quarantined = (s: Src) => db.select({ line: quarantineRows.lineNo, reasons: quarantineRows.reasons }).from(quarantineRows)
  .where(eq(quarantineRows.sourceId, s.sourceId)).orderBy(asc(quarantineRows.lineNo));
const filesOf = (s: Src) => db.select().from(sourceFiles).where(eq(sourceFiles.sourceId, s.sourceId)).orderBy(asc(sourceFiles.receivedAt), asc(sourceFiles.id));
const statusOf = async (s: Src) => (await db.select({ status: sources.status }).from(sources).where(eq(sources.id, s.sourceId)))[0]!.status;
const cursorOf = async (s: Src) => (await db.select().from(sourceCursors).where(eq(sourceCursors.sourceId, s.sourceId)))[0];

/** Writes `name` in the inbox folder; `at` = its modification time (a resend is a new arrival). */
async function put(name: string, text: string, at = new Date()) {
  await writeFile(path.join(DIR, name), text);
  await utimes(path.join(DIR, name), at, at);
}
/** Scans the inbox of `s` and ingests every new complete file, one after the other. */
async function deliver(s: Src): Promise<string[]> {
  const out: string[] = [];
  for (const f of await scanSource(scope(s), probe, LATER())) out.push(await ingestFile(scope(s), f, probe));
  return out;
}

beforeAll(async () => {
  probe = await appRoleDb();
  ({ sql: src, secret } = await sourceDb());
  await src.unsafe(`
    drop table if exists medallion, bifast, chg, nulls_wm, mut;
    create table medallion (business_date date not null, sid text not null, sre text, fail boolean not null default false);
    create table bifast (id bigint generated always as identity primary key, updated_at timestamptz not null, ext_ref text not null, account_ref text not null, amount numeric(18,2) not null, event_time timestamptz not null);
    create table chg (id bigint generated always as identity primary key, updated_at timestamptz not null, ref text not null, amt numeric(18,2), extra text);
    create table nulls_wm (id bigint generated always as identity primary key, updated_at timestamptz, ref text not null);
    create table mut (id bigint primary key, updated_at timestamptz not null, ref text not null, status text not null);
  `);
});
afterAll(async () => {
  await probe.$client.close();
  await src.close();
  await rm(DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  Object.assign(ingestHooks, defaultHooks);
  await truncateAll();
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }]);
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] });
  await src.unsafe("truncate medallion, chg, nulls_wm, mut; truncate bifast restart identity");
});

// ------------------------------------------------------------------------------------------------ KSEI two days
// no ORDER BY: the cursor reads in heap order, so a bad row late in it breaks a page after earlier pages were stored
const MEDALLION_QUERY = "select sid, sre, business_date from medallion where business_date = :business_date and 1 / (case when fail then 0 else 1 end) = 1";
const medallionSpec = (): SourceSpec => ({
  fields: [
    { name: "sid", type: "string", nullable: false, trim: true },
    { name: "sre", type: "string", nullable: true, trim: true },
    { name: "business_date", type: "date", nullable: false, trim: true },
  ],
  mapping: { business_date: { field: "business_date" }, account_ref: { field: "sid" }, attrs: { sre: { field: "sre" } } },
  derive: {}, key_fields: ["sid"], mutable: false, calendar: "id-default",
  input: { kind: "db_snapshot", query: MEDALLION_QUERY, schedule: "0 6 * * *" },
});
async function medallion(date: string, sids: number[], doubleS10 = false) {
  for (const n of sids) await src`insert into medallion (business_date, sid, sre) values (${date}::date, ${sid(n)}, ${`TSTSRE${String(n).padStart(3, "0")}`})`;
  if (doubleS10) await src`insert into medallion (business_date, sid, sre) values (${date}::date, ${sid(10)}, 'TSTSRE010A'), (${date}::date, ${sid(10)}, 'TSTSRE010B')`;
}

describe("KSEI ACT, day D and D+1 (ksei-sample-data.md)", () => {
  it("D: the file gives 10 records and 2 quarantined lines with a reason per column; the snapshot keeps both S10 rows; D+1 adds 9 and 9", async () => {
    const k = await source(A, kseiSpec());
    await put("act20261102.txt", KSEI_FILE);
    expect(await deliver(k)).toEqual(["ingested"]);
    expect(await current(k, D)).toBe(10);
    expect(await quarantined(k)).toEqual([
      { line: 11, reasons: { _row: "Expected 14 columns, got 13" } },
      { line: 12, reasons: { sid: "sid is required" } },
    ]);
    expect(await filesOf(k)).toMatchObject([{ name: "act20261102.txt", status: "ingested", version: 1, businessDate: D, rowsTotal: 12, rowsOk: 10, rowsNew: 10, rowsQuarantined: 2 }]);
    expect(await deliver(k)).toEqual([]); // the same arrival is not picked up twice

    const m = await source(A, medallionSpec());
    await medallion(D, [1, 2, 3, 4, 5, 6, 7, 8, 11], true);
    expect(await snapshotSource(scope(m), D, probe)).toBe("active");
    expect(await current(m, D)).toBe(11);
    const s10 = await db.select({ sre: records.attrs }).from(records).where(and(eq(records.sourceId, m.sourceId), eq(records.accountRef, sid(10))));
    expect(s10.map((r) => (r.sre as { sre: string }).sre).sort()).toEqual(["TSTSRE010A", "TSTSRE010B"]);

    await put("act20261103.txt", [1, 2, 3, 4, 5, 6, 7, 8, 11].map(kseiLine).join("\n") + "\n");
    expect(await deliver(k)).toEqual(["ingested"]);
    await medallion(D1, [1, 2, 3, 4, 5, 6, 7, 8, 11]);
    expect(await snapshotSource(scope(m), D1, probe)).toBe("active");
    expect([await current(k, D), await current(k, D1), await current(m, D), await current(m, D1)]).toEqual([10, 9, 11, 9]);
    const c = await cursorOf(k);
    expect(c?.completeThrough?.toISOString()).toBe("2026-11-03T17:00:00.000Z"); // the end of D+1 in Asia/Jakarta
  });
});

// ------------------------------------------------------------------------------------------------ Review Focus 1
describe("Review Focus 1: a file sent again", () => {
  it("the same content is rejected and changes no count; the same name with new content is the next version", async () => {
    const k = await source(A, kseiSpec());
    await put("act20261102.txt", KSEI_FILE, new Date(Date.now() - 3_600_000));
    expect(await deliver(k)).toEqual(["ingested"]);
    await put("act20261102.txt", KSEI_FILE); // resent: same bytes, a new arrival
    expect(await deliver(k)).toEqual(["rejected"]);
    expect([await current(k), (await quarantined(k)).length]).toEqual([10, 2]);
    const [first, again] = await filesOf(k);
    expect(again).toMatchObject({ status: "rejected", reason: "Same file already ingested", versionOf: first!.id, sha256: first!.sha256, rowsNew: 0 });

    const v2 = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(kseiLine), kseiLine(13), kseiLine(14)].join("\n") + "\n";
    await put("act20261102.txt", v2, new Date(Date.now() + 1000));
    expect(await deliver(k)).toEqual(["ingested"]);
    expect((await filesOf(k))[2]).toMatchObject({ status: "ingested", version: 2, versionOf: first!.id, rowsOk: 12, rowsNew: 2, rowsQuarantined: 0 });
    expect(await current(k)).toBe(12);
  });

  it("a quote never closed fails the whole file: nothing of it is written, the reason is kept", async () => {
    const k = await source(A, kseiSpec({ format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } } as never));
    await put("act20261104.txt", `${kseiLine(1)}\n"${kseiLine(2)}\n${kseiLine(3)}\n`);
    expect(await deliver(k)).toEqual(["failed"]);
    expect([await allRecords(k), (await quarantined(k)).length]).toEqual([0, 0]);
    expect((await filesOf(k))[0]).toMatchObject({ status: "failed", reason: "Quote not closed (line 2)" });
    expect(await statusOf(k)).toBe("active"); // a broken file is the file's fault, not a schema change
  });
});

// ------------------------------------------------------------------------------------------------ Review Focus 2
describe("Review Focus 2: a snapshot that fails halfway", () => {
  it("leaves the date's active snapshot whole; the failed one is kept as failed; the next good one supersedes", async () => {
    const m = await source(A, medallionSpec());
    await medallion(D, [1, 2, 3, 4, 5, 6, 7, 8, 11], true);
    expect(await snapshotSource(scope(m), D, probe)).toBe("active");
    // the re-pull reads 5 rows a page and breaks on S07, which its UPDATE moved to the end of the heap
    ingestHooks.connect = (c) => {
      const real = defaultHooks.connect(c);
      return { ...real, pullSnapshot: (q, d, o) => real.pullSnapshot(q, d, { ...o, chunk: 5 }) };
    };
    await src`update medallion set fail = true where sid = ${sid(7)}`;
    expect(await snapshotSource(scope(m), D, probe)).toBe("failed");
    const snaps = () => db.select({ status: sourceSnapshots.status, rows: sourceSnapshots.rows }).from(sourceSnapshots)
      .where(eq(sourceSnapshots.sourceId, m.sourceId)).orderBy(asc(sourceSnapshots.startedAt), asc(sourceSnapshots.id));
    expect(await snaps()).toEqual([{ status: "active", rows: 11 }, { status: "failed", rows: 10 }]); // two pages stored, then S07 broke the query (its UPDATE moved it to the end)
    expect(await current(m, D)).toBe(11);
    expect(await statusOf(m)).toBe("active");
    expect((await cursorOf(m))?.lastError).toBe(`Snapshot ${D}: The source database refused the query (22012).`);

    await src`update medallion set fail = false`;
    await src`delete from medallion where sid = ${sid(11)}`;
    expect(await snapshotSource(scope(m), D, probe)).toBe("active");
    expect((await snaps()).map((s) => s.status)).toEqual(["superseded", "failed", "active"]);
    expect(await current(m, D)).toBe(10);
  });

  it("a closed day is not pulled again (Plan 5: rerun with approval)", async () => {
    const m = await source(A, medallionSpec());
    ingestHooks.dayClosed = async () => true;
    expect(await snapshotSource(scope(m), D, probe)).toBe("day_closed");
    expect((await db.select().from(sourceSnapshots)).length).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ Review Focus 3
const bifastSpec = (o: { lookback?: number; chunk?: number } = {}): SourceSpec => ({
  fields: [
    { name: "ext_ref", type: "string", nullable: false, trim: true },
    { name: "account_ref", type: "string", nullable: false, trim: true },
    { name: "amount", type: "decimal", nullable: false, trim: true, format: { scale: 2 } },
    { name: "event_time", type: "datetime", nullable: false, trim: true },
  ],
  mapping: { business_date: { field: "event_time" }, event_time: { field: "event_time" }, amount_minor: { field: "amount" }, ext_ref: { field: "ext_ref" }, account_ref: { field: "account_ref" }, attrs: {} },
  derive: {}, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "db_watermark", table: "public.bifast", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: o.lookback ?? 120, chunk: o.chunk ?? 7 },
});

describe("Review Focus 3: tied timestamps and late commits (BI-FAST synthetic, synth.ts)", () => {
  it("keyset + lookback + dedup: every row once across pulls, none lost, none twice", async () => {
    const { a } = synthPair({ ...DEFAULTS, rows: 120, seed: 7, date: "2026-11-19" });
    const insert = async (rows: typeof a, updatedAt: (i: number) => string) => {
      for (const [i, r] of rows.entries()) {
        await src`insert into bifast (updated_at, ext_ref, account_ref, amount, event_time)
          values (${updatedAt(i)}::timestamptz, ${r.ext_ref}, ${r.account_ref}, ${(Number(r.amount_minor) / 100).toFixed(2)}::numeric, ${r.event_time.toISOString()}::timestamptz)`;
      }
    };
    // 9 rows share each timestamp, 37 µs apart: ties cross every 7-row page
    const tick = (i: number) => `2026-11-19T01:00:00.${String(37 * Math.floor(i / 9)).padStart(6, "0")}Z`;
    const first = a.slice(0, 80), late = a.slice(80, 100), fresh = a.slice(100);
    await insert(first, (i) => tick(i));
    const s = await source(A, bifastSpec());
    expect(await pullSource(scope(s), probe)).toBe("pulled");
    expect(await current(s)).toBe(first.length);
    expect((await cursorOf(s))!.watermark).toBe("2026-11-19T01:00:00.000296Z");
    // transactions that committed late: timestamps at and under the watermark (inside the 120 s lookback), then new ones
    await insert(late, (i) => (i % 2 ? "2026-11-19T01:00:00.000296Z" : "2026-11-19T01:00:00.000100Z"));
    await insert(fresh, (i) => `2026-11-19T01:00:05.${String(i).padStart(3, "0")}Z`);
    expect(await pullSource(scope(s), probe)).toBe("pulled");
    expect(await pullSource(scope(s), probe)).toBe("pulled"); // nothing new: the lookback pages come again, dedup drops them
    const [{ n: rows }] = await src`select count(*)::int as n from bifast`;
    expect(await current(s)).toBe(rows);
    expect(await allRecords(s)).toBe(rows);
    const c = await cursorOf(s);
    const ms = String(fresh.length - 1).padStart(3, "0"); // the newest row: microsecond text from the source, as written
    expect(c).toMatchObject({ lastError: null, watermark: `2026-11-19T01:00:05.${ms}000Z` });
    expect(c!.completeThrough!.toISOString()).toBe(`2026-11-19T00:58:05.${ms}Z`); // watermark − lookback
  });

  it("a page the connector sends twice before it gives up (\"did not move\") is stored once; the source pauses with the reason", async () => {
    const s = await source(A, bifastSpec());
    const page: Row[] = [1, 2, 3].map((i) => ({ ext_ref: `R${i}`, account_ref: "ACC1", amount: "1.00", event_time: "2026-11-19T01:00:00Z", updated_at: "2026-11-19T01:00:00Z", id: String(i) }));
    const stuck = new ConnectorError("spec", null, "The pull did not move past watermark 2026-11-19T01:00:00Z and id 3.");
    ingestHooks.connect = () => ({
      introspect: async () => ["ext_ref", "account_ref", "amount", "event_time", "updated_at", "id"].map((name) => ({ name, type: "text", nullable: false })),
      pullWatermark: async function* () { yield page; yield page; throw stuck; },
      close: async () => {},
    }) as unknown as Connector;
    expect(await pullSource(scope(s), probe)).toBe("paused");
    expect(await allRecords(s)).toBe(3);
    expect([await statusOf(s), (await cursorOf(s))?.lastError]).toEqual(["paused", stuck.message]);
  });

  it("a watermark or id column that may be NULL is refused before the first pull", async () => {
    await src`insert into nulls_wm (updated_at, ref) values (now(), 'R1'), (null, 'R2')`;
    const spec = { ...bifastSpec(), fields: [{ name: "ref", type: "string" as const, nullable: false, trim: true }], mapping: { business_date: { cel: "'2026-11-19'" }, ext_ref: { field: "ref" }, attrs: {} },
      input: { ...bifastSpec().input, table: "public.nulls_wm" } } as SourceSpec;
    const s = await source(A, spec);
    expect(await pullSource(scope(s), probe)).toBe("paused");
    expect(await allRecords(s)).toBe(0);
    expect((await cursorOf(s))?.lastError).toMatch(/^Column "updated_at" of table public\.nulls_wm may be empty \(nullable\)/);
  });
});

// ------------------------------------------------------------------------------------------------ Review Focus 4
describe("Review Focus 4: the source's columns change", () => {
  const chgSpec = (): SourceSpec => ({
    fields: [{ name: "ref", type: "string", nullable: false, trim: true }, { name: "amt", type: "decimal", nullable: true, trim: true, format: { scale: 2 } }],
    mapping: { business_date: { cel: "'2026-11-19'" }, ext_ref: { field: "ref" }, amount_minor: { field: "amt" }, attrs: {} },
    derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_watermark", table: "public.chg", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 0, chunk: 100 },
  });

  it("a column that changed type pauses the source with what changed, and nothing more is written", async () => {
    await src`insert into chg (updated_at, ref, amt) values (now(), 'R1', 1.5)`;
    const s = await source(A, chgSpec());
    expect(await pullSource(scope(s), probe)).toBe("pulled");
    await src.unsafe("alter table chg alter column amt type text using amt::text");
    await src`insert into chg (updated_at, ref, amt) values (now() + interval '1 second', 'R2', 'abc')`;
    expect(await pullSource(scope(s), probe)).toBe("paused");
    expect(await allRecords(s)).toBe(1);
    expect([await statusOf(s), (await cursorOf(s))?.lastError]).toEqual(["paused", 'Column "amt" changed from numeric(18,2) to text in table public.chg. Make a new source version for the columns it has now.']);
    expect(await pullSource(scope(s), probe)).toBe("skipped"); // paused: pulls write nothing
    await src.unsafe("alter table chg alter column amt type numeric(18,2) using null");
  });

  it("a missing column pauses the source before any row is read", async () => {
    await src`insert into chg (updated_at, ref, amt) values (now(), 'R1', 1.5)`;
    const s = await source(A, { ...chgSpec(), fields: [...chgSpec().fields, { name: "gone", type: "string", nullable: true, trim: true }] });
    expect(await pullSource(scope(s), probe)).toBe("paused");
    expect(await allRecords(s)).toBe(0);
    expect((await cursorOf(s))?.lastError).toBe('Column "gone" is no longer in table public.chg. Make a new source version for the columns it has now.');
  });

  it("a file whose header is wider than the declared fields fails and pauses its source", async () => {
    const k = await source(A, kseiSpec({ format: { kind: "delimited", delimiter: "|", quote: null, header: true, encoding: "utf-8" } } as never));
    await put("act20261102.txt", `${Array.from({ length: 15 }, (_, i) => `c${i}`).join("|")}\n${kseiLine(1)}\n`);
    expect(await deliver(k)).toEqual(["failed"]);
    expect([await allRecords(k), await statusOf(k)]).toEqual([0, "paused"]);
    expect((await filesOf(k))[0]!.reason).toBe("The header has 15 columns; the source declares 14");
  });
});

// ------------------------------------------------------------------------------------------------ Review Focus 5
describe("Review Focus 5: no leak between spaces, through the handlers too", () => {
  it("a job scoped to space B can't touch space A's source; the same file in two spaces is two files, each seen only in its space", async () => {
    const ka = await source(A, kseiSpec());
    const kb = await source(B, kseiSpec());
    await put("act20261102.txt", KSEI_FILE);
    const [file] = await scanSource(scope(ka), probe, LATER()) as [InboxFile];
    expect(await ingestFile({ spaceId: B, sourceId: ka.sourceId }, file, probe)).toBe("skipped");
    expect(await scanSource({ spaceId: B, sourceId: ka.sourceId }, probe, LATER())).toEqual([]);
    expect(await allRecords(ka)).toBe(0);
    expect(await ingestFile(scope(ka), file, probe)).toBe("ingested");
    expect(await ingestFile(scope(kb), file, probe)).toBe("ingested"); // same sha256 and rows in B: no unique key across spaces
    const seen = (spaceId: string) => withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => ({
      records: (await tx.select({ s: records.sourceId }).from(records)).map((r) => r.s),
      files: (await tx.select({ s: sourceFiles.sourceId }).from(sourceFiles)).map((r) => r.s),
    }), probe);
    const a = await seen(A), b = await seen(B);
    expect([new Set(a.records), new Set(b.records)]).toEqual([new Set([ka.sourceId]), new Set([kb.sourceId])]);
    expect([a.records.length, b.records.length, a.files, b.files]).toEqual([10, 10, [ka.sourceId], [kb.sourceId]]);
    expect(await pullSource({ spaceId: B, sourceId: ka.sourceId }, probe)).toBe("skipped");
  });
});

// ------------------------------------------------------------------------------------------------ mutable, partitions
describe("a mutable source", () => {
  it("a changed row is a new record; the one it replaces gets superseded_by and reaches onRecordChanged", async () => {
    await src`insert into mut values (1, '2026-11-19T01:00:00Z', 'R1', 'pending'), (2, '2026-11-19T01:00:00Z', 'R2', 'pending')`;
    const spec: SourceSpec = {
      fields: [{ name: "ref", type: "string", nullable: false, trim: true }, { name: "status", type: "string", nullable: false, trim: true }],
      mapping: { business_date: { cel: "'2026-11-19'" }, ext_ref: { field: "ref" }, attrs: { status: { field: "status" } } },
      derive: {}, key_fields: ["ref"], mutable: true, calendar: "id-default",
      input: { kind: "db_watermark", table: "public.mut", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 60, chunk: 10 },
    };
    const s = await source(A, spec);
    const changed: string[][] = [];
    ingestHooks.onRecordChanged = async (_tx, ids) => { changed.push(ids); };
    expect(await pullSource(scope(s), probe)).toBe("pulled");
    const [old] = await db.select({ id: records.id }).from(records).where(eq(records.extRef, "R1"));
    await src`update mut set status = 'success', updated_at = '2026-11-19T01:00:30Z' where id = 1`;
    expect(await pullSource(scope(s), probe)).toBe("pulled");
    const r1 = await db.select({ id: records.id, by: records.supersededBy, attrs: records.attrs }).from(records).where(eq(records.extRef, "R1")).orderBy(asc(records.id));
    expect(r1.map((r) => (r.attrs as { status: string }).status)).toEqual(["pending", "success"]);
    expect(r1[0]).toMatchObject({ id: old!.id, by: r1[1]!.id });
    expect(r1[1]!.by).toBeNull();
    expect(changed).toEqual([[old!.id]]);
    expect(await current(s)).toBe(2);
  });
});

describe("maintenance.partitions", () => {
  it("adds this month and the next two to records and raw_rows, as the app role", async () => {
    await ensureIngestPartitions(probe, new Date("2027-05-20T00:00:00Z"));
    for (const t of ["records", "raw_rows"]) {
      expect((await partitionsOf(t)).map((p) => p.name).filter((n) => n >= `${t}_2027_05`)).toEqual([`${t}_2027_05`, `${t}_2027_06`, `${t}_2027_07`]);
    }
  });
});
