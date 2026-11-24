// Demo sources of Treasury (Figma page 04 Space map names) and one shared to CTOP, with just enough ingest rows for
// every state of the sources screens (Figma page 02, Build notes 02 "Plan 2 state coverage"): a file rejected as the
// same content and a file's version 2 (a), a failed re-pull that kept the active snapshot (b), a source paused by a
// changed table with its drift per column (c), quarantine over more than one page (e), a source read through a share
// (h), a watermark lag past half the grace and a date without an active snapshot or ingested file. Dates follow the
// seed's day: D = the business day before today (id-default calendar), so health reads as described on that day.
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SourceKind } from "@starterkit/shared/sources";
import { encryptSecret } from "../../kernel/crypto";
import type { InTx, Tx } from "../../kernel/db";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { makeCalendar, previousBusinessDay, quarantineRows, rawHashOf, recountDays, records, sourceCursors, sourceFiles, sourceSnapshots, todayIn } from "../../modules/ingest";
import { sourceConnections, sourceShares, sources, sourceVersions } from "../../modules/sources";
import { withSpace } from "../../modules/spaces";

const DAY = 86_400_000;
const MIN = 60_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** `hhmm` WIB on `date` (UTC+7 all year). */
const wib = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);
const compact = (date: string) => date.replaceAll("-", "");

const FIELDS = [
  { name: "ref", type: "string", nullable: false, trim: true },
  { name: "amount", type: "decimal", format: { scale: 2 }, nullable: false, trim: true },
  { name: "value_date", type: "date", format: { date: "yyyyMMdd" }, nullable: false, trim: true },
];
// every demo source writes rupiah in whole units (amount 1500.00 = IDR 1,500.00 = 150000 minor)
const base = { fields: FIELDS, derive: {}, key_fields: ["ref"], mutable: false, calendar: "id-default", currency: "IDR" };
const mapping = { business_date: { field: "value_date" }, amount_minor: { field: "amount", unit: "major" }, ext_ref: { field: "ref" }, attrs: {} };
const fileSpec = (folder: string, pattern: string) => SourceSpec.parse({
  ...base, mapping, input: {
    kind: "file_inbox", path: `/inbox/treasury/${folder}`, pattern, completion: { kind: "stable_seconds", seconds: 60 },
    format: { kind: "delimited", delimiter: "|", quote: '"', header: true, encoding: "utf-8" },
  },
});
const pullSpec = (table: string) => SourceSpec.parse({
  ...base, fields: [...FIELDS, { name: "updated_at", type: "datetime", nullable: false, trim: true }, { name: "id", type: "string", nullable: false, trim: true }],
  mapping, health: { graceMinutes: 1440 },
  input: { kind: "db_watermark", table, watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 300, chunk: 5000 },
});
const snapshotSpec = (table: string, deadline: string) => SourceSpec.parse({
  ...base, mapping, health: { deadline },
  input: { kind: "db_snapshot", query: `select ref, amount, value_date from ${table} where value_date = :business_date`, schedule: "0 6 * * *" },
});

type Source = { id: string; versionId: string; code: string; name: string; kind: SourceKind; spec: SourceSpec; engine?: "postgres" | "mssql" | "oracle"; status?: "paused" };

/**
 * Treasury's sources and their ingest rows, written as Treasury (withSpace) inside the demo seed's transaction;
 * `bi-settlement` is shared to CTOP. `maker`/`checker` = Treasury's config maker and checker.
 */
export async function seedDemoSources(db: Tx, o: { treasury: string; ctop: string; maker: string; checker: string; now: number }): Promise<void> {
  const today = todayIn(new Date(o.now));
  const D = previousBusinessDay(makeCalendar({ weekend: [6, 7], holidays: [] }), today);
  const id = () => Bun.randomUUIDv7();
  const src = (code: string, name: string, kind: SourceKind, spec: SourceSpec, more: Partial<Source> = {}): Source =>
    ({ id: id(), versionId: id(), code, name, kind, spec, ...more });
  const list = {
    biSettlement: src("bi-settlement", "BI settlement file", "file_inbox", fileSpec("bi", "bisettle{yyyyMMdd}.txt")),
    bifastIn: src("bifast-in", "Core bank · BI-FAST incoming", "db_watermark", pullSpec("core.bifast_in"), { engine: "postgres" }),
    bifastOut: src("bifast-out", "Core bank · BI-FAST outgoing", "db_watermark", pullSpec("core.bifast_out"), { engine: "postgres" }),
    rtgsStatement: src("bi-rtgs", "BI-RTGS statement", "file_inbox", fileSpec("rtgs", "rtgs{yyyyMMdd}.csv")),
    coreRtgs: src("core-rtgs", "Core bank · RTGS", "db_snapshot", snapshotSpec("core.rtgs_txn", "09:00"), { engine: "oracle" }),
    sknbiFile: src("sknbi", "SKNBI clearing file", "file_inbox", fileSpec("sknbi", "sknbi{yyyyMMdd}.txt")),
    coreSknbi: src("core-sknbi", "Core bank · SKNBI", "db_snapshot", snapshotSpec("core.sknbi_txn", "23:59"), { engine: "mssql" }),
    mt950: src("mt950-citi-ny", "MT950 · Citi New York", "file_inbox", fileSpec("swift", "mt950_citiny_{yyyyMMdd}.txt")),
    glNostro: src("gl-nostro-usd", "GL nostro USD", "db_snapshot", snapshotSpec("gl.nostro_usd", "09:00"), { engine: "oracle", status: "paused" }),
  };
  const all = Object.values(list);
  const T = o.treasury;
  /** A time of the business day after D, but never later than `min` minutes before the seed runs (no event in the future). */
  const past = (d: Date, min: number) => (d.getTime() <= o.now - min * MIN ? d : new Date(o.now - min * MIN));
  const s = (x: Source) => ({ spaceId: T, sourceId: x.id });
  const created = new Date(o.now - 40 * DAY);

  await withSpace({ spaceIds: [T], userId: null }, async (tx: InTx) => {
    await ensureMonthPartitions(tx, records, new Date(`${shift(D, -3)}T00:00:00Z`), 2);
    await tx.insert(sources).values(all.map((x) => ({ id: x.id, spaceId: T, code: x.code, name: x.name, kind: x.kind, status: x.status ?? "active", createdAt: created, updatedAt: created })));
    await tx.insert(sourceVersions).values(all.map((x) => ({
      id: x.versionId, ...s(x), version: 1, status: "published", spec: x.spec, specHash: `demo-${x.code}`, makerId: o.maker, contributorIds: [o.maker],
      checkerId: o.checker, publishedAt: new Date(o.now - 30 * DAY), createdAt: created, updatedAt: created,
    })));
    // the credential is a demo value: no such database exists, and it is never answered
    await tx.insert(sourceConnections).values(all.filter((x) => x.engine).map((x) => ({
      ...s(x), engine: x.engine!, options: { tls: true, connectTimeoutSeconds: 15 },
      secretEnc: encryptSecret(JSON.stringify({ host: "core-db.demo.invalid", port: 1521, database: "CORE", user: "recon_ro", password: "demo-only" })),
    })));
    await tx.insert(sourceShares).values({ spaceId: T, sourceId: list.biSettlement.id, toSpaceId: o.ctop });

    const recs: (typeof records.$inferInsert)[] = [];
    const addRecords = (x: Source, businessDate: string, n: number, originId: string, snapshotId: string | null = null, offset = 0) => {
      for (let i = 0; i < n; i++) {
        const ref = `${x.code.toUpperCase()}-${compact(businessDate)}-${String(i + offset + 1).padStart(4, "0")}`;
        recs.push({
          id: id(), spaceId: T, sourceId: x.id, sourceVersionId: x.versionId, businessDate, bdayIndex: 1, extRef: ref, amountMinor: BigInt(100_000 + (i + offset) * 2_550),
          currency: "IDR", attrs: {}, rowHash: `${ref}-${snapshotId ?? "f"}`, naturalKey: ref, snapshotId, originId,
        });
      }
    };
    const quarantine: (typeof quarantineRows.$inferInsert)[] = [];
    const quarantined = (x: Source, origin: "file" | "pull" | "snapshot", originId: string, businessDate: string | null, lines: [number, string, Record<string, string>][]) => {
      for (const [lineNo, raw, reasons] of lines) quarantine.push({ id: id(), ...s(x), origin, originId, lineNo, raw, rawHash: rawHashOf(raw), reasons, businessDate });
    };

    // (a) BI settlement file: D−2 with a quarantine of 18 lines (two pages), D−1 as version 1, the same content again
    // (rejected) and version 2, and D's file.
    const bi = list.biSettlement;
    const file = (name: string, businessDate: string, at: Date, rest: Partial<typeof sourceFiles.$inferInsert>) =>
      ({ id: id(), ...s(bi), name, businessDate, size: 2_048, modifiedAt: at, receivedAt: at, sha256: "", status: "ingested", ...rest });
    const f2 = file(`bisettle${compact(shift(D, -2))}.txt`, shift(D, -2), wib(shift(D, -1), "06:10"), { sha256: "4be1c07d93a2f0e8c6b55d10e7a4f3d2a9c0b17e8f6d5c4b3a2918f7e6d5c4b3", version: 1, rowsTotal: 40, rowsOk: 22, rowsNew: 22, rowsQuarantined: 18 });
    const f1v1 = file(`bisettle${compact(shift(D, -1))}.txt`, shift(D, -1), wib(D, "06:11"), { sha256: "9f2c4d1e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3aa71e", version: 1, rowsTotal: 12, rowsOk: 10, rowsNew: 10, rowsQuarantined: 2 });
    const f1rej = file(f1v1.name, shift(D, -1), wib(D, "08:02"), { sha256: f1v1.sha256, status: "rejected", reason: "Same file already ingested", versionOf: f1v1.id });
    const f1v2 = file(f1v1.name, shift(D, -1), wib(D, "08:40"), { sha256: "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901122", version: 2, versionOf: f1v1.id, rowsTotal: 12, rowsOk: 12, rowsNew: 2, rowsQuarantined: 0 });
    const f0 = file(`bisettle${compact(D)}.txt`, D, past(wib(today, "06:12"), 180), { sha256: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b", version: 1, rowsTotal: 10, rowsOk: 9, rowsNew: 9, rowsQuarantined: 1 });
    addRecords(bi, shift(D, -2), 22, f2.id);
    addRecords(bi, shift(D, -1), 10, f1v1.id);
    addRecords(bi, shift(D, -1), 2, f1v2.id, null, 10);
    addRecords(bi, D, 9, f0.id);
    const line = (n: number, date: string, cells = 3) => [`BIS-${compact(date)}-${String(n).padStart(4, "0")}`, "1250000.00", compact(date)].slice(0, cells).join("|");
    quarantined(bi, "file", f2.id, shift(D, -2), Array.from({ length: 18 }, (_, i): [number, string, Record<string, string>] => i % 3 === 0
      ? [i + 2, line(i + 2, shift(D, -2), 2), { _row: "Expected 3 columns, found 2" }]
      : i % 3 === 1 ? [i + 2, `|12500${String(i + 2).padStart(2, "0")}.00|${compact(shift(D, -2))}`, { ref: "Empty; ref can't be empty" }]
        : [i + 2, `BIS-${i + 2}|12,50.0|${compact(shift(D, -2))}`, { amount: "'12,50.0' isn't a decimal with . as the separator" }]));
    quarantined(bi, "file", f1v1.id, shift(D, -1), [[11, line(11, shift(D, -1), 2), { _row: "Expected 3 columns, found 2" }], [12, `|1250000.00|${compact(shift(D, -1))}`, { ref: "Empty; ref can't be empty" }]]);
    quarantined(bi, "file", f0.id, D, [[7, `BIS-0007|1250000.00|${compact(D).slice(0, 6)}31`, { value_date: `'${compact(D).slice(0, 6)}31' isn't a date in yyyyMMdd` }]]);

    // Watermark pulls against a grace of a day: BI-FAST incoming 2 minutes behind (Healthy for about 12 hours), outgoing
    // 721 minutes behind, past half the grace (Degraded until it passes the grace, about 12 hours on).
    for (const [x, lagMin, n] of [[list.bifastIn, 2, 25], [list.bifastOut, 721, 15]] as const) {
      const ct = new Date(o.now - lagMin * MIN);
      await tx.insert(sourceCursors).values({
        ...s(x), watermark: new Date(ct.getTime() + 300_000).toISOString(), watermarkId: `${x.code}-${n}`, completeThrough: ct, lastSuccessAt: new Date(o.now - MIN),
        lastError: x === list.bifastOut ? "The source database didn't answer within 15 s (timeout)." : null,
      });
      addRecords(x, today, n, id());
    }
    quarantined(list.bifastOut, "pull", id(), null, [[3, JSON.stringify(["BFO-0003", "", "2026"]), { amount: "Empty; amount can't be empty" }], [9, JSON.stringify(["BFO-0009", "abc", "2026"]), { amount: "'abc' isn't a decimal" }]]);

    // BI-RTGS statement: D−1's file only, so D has no ingested file yet (Degraded). SKNBI and MT950: D's file (Healthy).
    const plain = (x: Source, date: string, n: number) => {
      const f = { id: id(), ...s(x), name: x.spec.input.kind === "file_inbox" ? x.spec.input.pattern.replace("{yyyyMMdd}", compact(date)) : "", sha256: id().replaceAll("-", "").padEnd(64, "0"), size: 1_024,
        modifiedAt: past(wib(shift(date, 1), "06:05"), 190), receivedAt: past(wib(shift(date, 1), "06:05"), 190), status: "ingested", version: 1, businessDate: date, rowsTotal: n, rowsOk: n, rowsNew: n };
      addRecords(x, date, n, f.id);
      return f;
    };
    const files = [f2, f1v1, f1rej, f1v2, f0, plain(list.rtgsStatement, shift(D, -1), 14), plain(list.sknbiFile, D, 11), plain(list.mt950, D, 6)];
    await tx.insert(sourceFiles).values(files);
    for (const [x, date] of [[bi, D], [list.rtgsStatement, shift(D, -1)], [list.sknbiFile, D], [list.mt950, D]] as const) {
      await tx.insert(sourceCursors).values({ ...s(x), completeThrough: wib(shift(date, 1), "00:00"), lastSuccessAt: past(wib(today, "06:12"), 180) });
    }

    // Snapshots. (b) Core bank · RTGS: D active from 06:00, its re-pull at 14:05 failed after 6 of 11 rows; D−1 replaced by a
    // re-pull; D−2 active. Core bank · SKNBI: D's pull failed, so no active snapshot for D (Degraded until 23:59).
    // (c) GL nostro USD: paused at 06:00 by a changed table; its snapshots stay.
    const snaps: (typeof sourceSnapshots.$inferInsert)[] = [];
    const snap = (x: Source, date: string, status: "active" | "failed" | "superseded", at: Date, rows: number, error: string | null = null) => {
      const sid = id();
      snaps.push({ id: sid, ...s(x), businessDate: date, status, rows, error, startedAt: at, finishedAt: new Date(at.getTime() + 400) });
      if (status === "active") addRecords(x, date, rows, sid, sid);
      return sid;
    };
    const rtgs = list.coreRtgs;
    snap(rtgs, shift(D, -2), "active", wib(shift(D, -1), "06:00"), 11);
    snap(rtgs, shift(D, -1), "superseded", wib(D, "06:00"), 11);
    snap(rtgs, shift(D, -1), "active", wib(D, "09:30"), 11);
    const rtgsActive = past(wib(today, "06:00"), 240);
    snap(rtgs, D, "active", rtgsActive, 9);
    snap(rtgs, D, "failed", past(wib(today, "14:05"), 60), 6, "The connection to the source database was lost (ORA-03113) after 6 of 11 rows.");
    const sknbi = list.coreSknbi;
    snap(sknbi, shift(D, -1), "active", wib(D, "06:00"), 8);
    snap(sknbi, D, "failed", past(wib(today, "06:00"), 120), 0, "The source database refused the connection (ECONNREFUSED).");
    const gl = list.glNostro;
    snap(gl, shift(D, -2), "active", wib(shift(D, -1), "06:00"), 7);
    snap(gl, shift(D, -1), "active", wib(D, "06:00"), 7);
    await tx.insert(sourceSnapshots).values(snaps);
    await tx.insert(sourceCursors).values([
      { ...s(rtgs), completeThrough: wib(shift(D, 1), "00:00"), lastSuccessAt: rtgsActive, lastError: `Snapshot ${D}: The connection to the source database was lost (ORA-03113).` },
      { ...s(sknbi), completeThrough: wib(D, "00:00"), lastSuccessAt: wib(D, "06:00"), lastError: `Snapshot ${D}: The source database refused the connection (ECONNREFUSED).` },
      {
        ...s(gl), completeThrough: wib(D, "00:00"), lastSuccessAt: wib(D, "06:00"), updatedAt: past(wib(today, "06:00"), 150),
        lastError: 'Column "ref" is no longer in the query. Make a new source version for the columns it has now.',
        drift: [
          { column: "ref", expected: "string", found: null, effect: "The column is gone, so it can't be read. Renamed? Pick the new column in a new version." },
          { column: "value_date", expected: "date", found: "VARCHAR2(9)", effect: "It can't hold a date; set the field's type in a new version." },
          { column: "amount", expected: "NUMBER(18,2)", found: "NUMBER(20,4)", effect: "The type changed since this version's first pull; check the field's type and format in a new version." },
        ],
      },
    ]);
    for (let i = 0; i < recs.length; i += 500) await tx.insert(records).values(recs.slice(i, i + 500));
    await tx.insert(quarantineRows).values(quarantine);
    await recountDays(tx, T); // rows written here, not by the pipeline: their day counters from them
  }, db);
}
