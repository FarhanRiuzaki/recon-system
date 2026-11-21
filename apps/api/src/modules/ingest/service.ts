// The ingest pipeline (spec §7 steps 3a–4, §8, §9): files from the inbox, watermark pulls and snapshots per business
// date, each row typed and mapped (map.ts) into raw_rows + records, or quarantined with its reasons. Run by the job
// handlers (handlers below, registered in src/worker.ts) on the worker's pool, as the app role, under withSpace scoped
// to the job's space: a job never reads or writes another space, and a source is found only in its own space.
//
// Idempotence (spike S2): each step is one transaction that writes its effect and its marker together. A pull page
// writes its rows and the watermark; a file writes all its rows and its source_files row at once (so a file that turns
// out broken leaves nothing); a snapshot writes its rows page by page under a `loading` snapshot, and one last
// transaction makes it active and supersedes the one before, so a date never has no active snapshot. A step of one
// source waits for the step before it (sourceLock). Dedup (spec §8): raw_rows and records once per (row_hash,
// business_date, snapshot), so a page or file sent again adds nothing.
//
// A source whose columns no longer fit its spec (a field gone, a type changed since the first pull of the version, a
// header of another width or with other names, a watermark that may be NULL) is paused with the reason and writes nothing until a new
// version is approved. A connection that fails leaves the source active with last_error; the next run tries again.
// A source of an archived space is not run at all (load answers null).
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  IngestListQuery, QuarantineRowDto, RunSourceBody, RunSourceDto, SourceDto, SourceFileDto, SourceSnapshotDto, SourceSpec,
} from "@starterkit/shared/contracts/sources";
import type { DbEngine, SourceKind, SourceStatus } from "@starterkit/shared/sources";
import { and, count, desc, eq, exists, inArray, isNull, max, or, sql } from "drizzle-orm";
import { loadWorkerConfig } from "../../kernel/config";
import { decryptSecret } from "../../kernel/crypto";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { enqueue, type JobHandler, type QueueName, QUEUES, scheduleEvery } from "../../kernel/jobs";
import { sourceLock } from "../../kernel/locks";
import { one, pageQuery } from "../../kernel/pagination";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { calendars, pauseSource, sourceConnections, sources, sourceShares, sourceVersions } from "../sources";
import { isSpaceArchived, withSpace } from "../spaces";
import { type Connector, ConnectorError, connectorFor, type From, type Row, type Secret } from "./connectors";
import { familyOf } from "./connectors/dialect";
import { insertBatch, makePartitions, MissingPartition, rawHashOf, supersede } from "./copy";
import { completeFiles, InboxError, inboxFile, sha256Of } from "./inbox";
import { type Calendar, fileDateOf, makeCalendar, toRecord } from "./map";
import { parseDelimited } from "./parse";
import { DEFAULT_TIMEZONE } from "./coerce";
import { sourceHealth } from "./health";
import { type Baseline, completeThroughOf, deadlineOn, type Drift, type DriftColumn, driftOf, endOfDay, nextRunOf, previousBusinessDay, todayIn } from "./rules";
import { quarantineRows, rawRows, records, sourceCursors, sourceDayCounts, sourceFiles, sourceSnapshots } from "./schema";

/** A job's source: the space it belongs to and its id. */
export type Scope = { spaceId: string; sourceId: string };
/** A complete file of the inbox, as the scan found it. */
export type InboxFile = { name: string; size: number; modifiedAt: number; sha256: string };
type StoredConnection = { engine: string; options: unknown; secretEnc: string };

const NOW = sql`now()`;
const EMPTY_SNAPSHOT = "The pull returned no rows; the active snapshot was kept.";
const QUARANTINED_SNAPSHOT = "Every row of the pull was quarantined; the active snapshot was kept.";
/** Rows a snapshot page holds (a snapshot query has no chunk setting of its own). */
const SNAPSHOT_CHUNK = 5000;
/** Lines of a file written per batch. */
const FILE_BATCH = 1000;
/** A watermark and file inbox source runs every minute (pg-boss's finest cron); a recon's own interval reads what is there. */
const EVERY_MINUTE = "* * * * *";

/**
 * Seams of later plans and tests. onRecordChanged: records of a mutable source just replaced (Plan 3 reverses their
 * matches; a no-op until then). dayClosed: whether a source's business date is closed (Plan 3–5: recon_day; until then
 * none is), so it is never pulled again outside a rerun. connect: the connector of a stored connection, with the
 * worker's statement timeout.
 */
export const ingestHooks = {
  onRecordChanged: async (_tx: InTx, _recordIds: string[]): Promise<void> => {},
  dayClosed: async (_tx: InTx, _source: Scope, _businessDate: string): Promise<boolean> => false,
  connect: (c: StoredConnection): Connector => {
    const o = c.options as { tls: boolean; connectTimeoutSeconds: number };
    return connectorFor(c.engine as DbEngine, JSON.parse(decryptSecret(c.secretEnc)) as Secret, {
      tls: o.tls, connectTimeoutSeconds: o.connectTimeoutSeconds, statementTimeoutMs: loadWorkerConfig(process.env).JOB_STATEMENT_TIMEOUT_MS,
    });
  },
};

const inScope = <T>(s: Scope, on: Tx, fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds: [s.spaceId], userId: null }, fn, on);

/** A record that counts now: the latest of its natural key, and from an active snapshot when it came in one. */
export const currentRecord = (tx: Tx) => and(isNull(records.supersededBy), or(isNull(records.snapshotId), exists(tx.select(one).from(sourceSnapshots)
  .where(and(eq(sourceSnapshots.spaceId, records.spaceId), eq(sourceSnapshots.id, records.snapshotId), eq(sourceSnapshots.status, "active"))))));

type Loaded = {
  status: string; versionId: string; spec: SourceSpec; calendar: Calendar;
  cursor: typeof sourceCursors.$inferSelect | undefined; conn: StoredConnection | undefined;
};

/**
 * Source `s` in its own space with its published version, calendar, cursor and connection; null when it has no
 * published version or its space is archived (an archived space keeps its data and ingests nothing more).
 */
async function load(tx: InTx, s: Scope): Promise<Loaded | null> {
  if (await isSpaceArchived(tx, s.spaceId)) return null;
  const [src] = await tx.select({ status: sources.status }).from(sources).where(and(eq(sources.spaceId, s.spaceId), eq(sources.id, s.sourceId)));
  if (!src) return null;
  const [v] = await tx.select({ id: sourceVersions.id, spec: sourceVersions.spec }).from(sourceVersions)
    .where(and(eq(sourceVersions.spaceId, s.spaceId), eq(sourceVersions.sourceId, s.sourceId), eq(sourceVersions.status, "published")));
  if (!v?.spec) return null;
  const spec = v.spec as SourceSpec;
  const [cal] = await tx.select({ weekend: calendars.weekend, holidays: calendars.holidays }).from(calendars).where(eq(calendars.code, spec.calendar));
  if (!cal) return null;
  const [cursor] = await tx.select().from(sourceCursors).where(and(eq(sourceCursors.spaceId, s.spaceId), eq(sourceCursors.sourceId, s.sourceId)));
  const [conn] = await tx.select({ engine: sourceConnections.engine, options: sourceConnections.options, secretEnc: sourceConnections.secretEnc })
    .from(sourceConnections).where(and(eq(sourceConnections.spaceId, s.spaceId), eq(sourceConnections.sourceId, s.sourceId)));
  return { status: src.status, versionId: v.id, spec, calendar: makeCalendar(cal), cursor, conn };
}

/** Writes the cursor; `completeThrough` only moves forward; clearing `lastError` clears the drift that came with it. */
async function setCursor(tx: InTx, s: Scope, set: Partial<typeof sourceCursors.$inferInsert>, completeThrough?: Date | null): Promise<void> {
  if (set.lastError === null) set = { ...set, drift: null };
  const ct = completeThrough ? { completeThrough: sql`greatest(${sourceCursors.completeThrough}, ${completeThrough.toISOString()}::timestamptz)` } : {};
  await tx.insert(sourceCursors).values({ ...s, ...set, ...(completeThrough ? { completeThrough } : {}) })
    .onConflictDoUpdate({ target: [sourceCursors.spaceId, sourceCursors.sourceId], set: { ...set, ...ct, updatedAt: NOW } });
}

/** Pauses the source with `reason` as its last error and, when its columns changed, `drift` per column. */
async function pause(tx: InTx, s: Scope, reason: string, drift: DriftColumn[] | null = null): Promise<void> {
  await pauseSource(tx, s.spaceId, s.sourceId);
  await setCursor(tx, s, { lastError: reason, drift });
}

type Line = { line: number; ok: true; raw: Row } | { line: number; ok: false; cells: string[]; reasons: Record<string, string> };
type Origin = {
  origin: "file" | "pull" | "snapshot"; originId: string; snapshotId: string | null;
  /** The file's name (its date for the mapping), or the snapshot's business date (every row must be of it). */
  fileName?: string; businessDate?: string;
  /** A line as quarantined text. */
  text: (cells: string[]) => string;
};
type Counts = { total: number; ok: number; added: number; quarantined: number };
const newCounts = (): Counts => ({ total: 0, ok: 0, added: 0, quarantined: 0 });

type CountKind = "records" | "quarantined";
/** Business date → how many, from a list of dates (each `sign`). */
function byDate(dates: Iterable<string>, sign = 1, into = new Map<string, number>()): Map<string, number> {
  for (const d of dates) into.set(d, (into.get(d) ?? 0) + sign);
  return into;
}
/** Adds `by` (business date → n) to the `kind` day counters of `s` (schema.ts sourceDayCounts); `set` replaces them. */
async function tally(tx: InTx, s: Scope, kind: CountKind, by: Map<string, number>, set = false): Promise<void> {
  const rows = [...by].filter(([, n]) => set || n !== 0).map(([businessDate, n]) => ({ ...s, businessDate, kind, n }));
  if (!rows.length) return;
  const c = sourceDayCounts;
  await tx.insert(c).values(rows).onConflictDoUpdate({ target: [c.spaceId, c.sourceId, c.businessDate, c.kind], set: { n: set ? sql`excluded.n` : sql`${c.n} + excluded.n` } });
}

/** Maps `lines` and writes them (rows, records, quarantine) in `tx`; mutable sources supersede what changed. */
async function writeLines(tx: InTx, s: Scope, l: Loaded, o: Origin, lines: Line[], counts: Counts): Promise<void> {
  const raw: (typeof rawRows.$inferInsert)[] = [], recs: (typeof records.$inferInsert)[] = [], quarantine: (typeof quarantineRows.$inferInsert)[] = [];
  const names = l.spec.fields.map((f) => f.name);
  const qDate = o.businessDate ?? (o.fileName ? fileDateOf(o.fileName) : null);
  const base = { spaceId: s.spaceId, sourceId: s.sourceId, origin: o.origin, originId: o.originId };
  for (const x of lines) {
    let reasons = x.ok ? null : x.reasons;
    const r = x.ok ? toRecord(x.raw, l.spec, { calendar: l.calendar, fileName: o.fileName, arrivedDate: o.businessDate }) : null;
    if (r && !r.ok) reasons = r.reasons;
    else if (r?.ok && o.businessDate && r.record.business_date !== o.businessDate) {
      reasons = { business_date: `business_date: ${r.record.business_date} is not the snapshot's date ${o.businessDate}` };
    }
    if (reasons || !r?.ok || !x.ok) {
      const cells = x.ok ? names.map((n) => x.raw[n] ?? "") : x.cells;
      const text = o.text(cells);
      quarantine.push({ id: Bun.randomUUIDv7(), ...base, lineNo: x.line, raw: text, rawHash: rawHashOf(text), reasons: reasons ?? {}, businessDate: qDate });
      continue;
    }
    const c = r.record;
    raw.push({ id: Bun.randomUUIDv7(), ...base, snapshotId: o.snapshotId, lineNo: x.line, payload: x.raw, rowHash: c.row_hash, businessDate: c.business_date });
    recs.push({
      id: Bun.randomUUIDv7(), spaceId: s.spaceId, sourceId: s.sourceId, sourceVersionId: l.versionId, businessDate: c.business_date, bdayIndex: c.bday_index,
      extRef: c.ext_ref, accountRef: c.account_ref, amountMinor: c.amount_minor, currency: c.currency, direction: c.direction,
      eventTime: c.event_time ? new Date(c.event_time) : null, attrs: c.attrs, rowHash: c.row_hash, naturalKey: c.natural_key,
      snapshotId: o.snapshotId, originId: o.originId,
    });
  }
  const { added, quarantined } = await insertBatch(tx, raw, recs, quarantine);
  // a pulled line has no business date of its own: it counts on the day it arrived (as the read model always did)
  await tally(tx, s, "quarantined", byDate(quarantined.map((q) => q.businessDate ?? todayIn(q.createdAt))));
  counts.total += lines.length;
  counts.ok += recs.length;
  counts.quarantined += quarantine.length;
  counts.added += added.length;
  // a snapshot is replaced whole per date (a mutable snapshot source is refused at save): its loading rows never
  // supersede the active snapshot's, so a failed pull can't leave the date empty; they count once it is active
  if (o.snapshotId) return;
  const current = byDate(added.map((a) => a.businessDate));
  if (l.spec.mutable && added.length) {
    const latest = new Map<string, string>(); // the newest record per key (UUIDv7 ids sort by creation)
    for (const a of added) if (a.naturalKey !== null && (latest.get(a.naturalKey) ?? "") < a.id) latest.set(a.naturalKey, a.id);
    const replaced = await supersede(tx, s.spaceId, s.sourceId, [...latest].map(([key, id]) => ({ key, id })));
    byDate(replaced.map((r) => r.businessDate), -1, current);
    if (replaced.length) await ingestHooks.onRecordChanged(tx, replaced.map((r) => r.id));
  }
  await tally(tx, s, "records", current);
}

/**
 * Runs `step` (one transaction); when its batch needs a month raw_rows or records has no partition for, the step has
 * rolled back, the month is made in a short transaction of its own (makePartitions), and the step runs again. So no
 * ingest transaction ever runs DDL.
 */
async function withPartitions<T>(on: Tx, step: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await step();
    } catch (e) {
      if (!(e instanceof MissingPartition) || i >= 3) throw e;
      await makePartitions(on, e.months);
    }
  }
}

/** A connector failure as the source's state: a spec error pauses it (with `drift` when its columns changed), anything else is its last error. */
async function connectorFailed(s: Scope, on: Tx, e: unknown, prefix = "", drift: Drift | null = null): Promise<"paused" | "failed"> {
  if (!(e instanceof ConnectorError)) throw e;
  const reason = prefix + e.message;
  await inScope(s, on, (tx) => (e.kind === "spec" ? pause(tx, s, reason, drift?.columns) : setCursor(tx, s, { lastError: reason })));
  return e.kind === "spec" ? "paused" : "failed";
}

/** The columns the spec reads, as first seen under this version: what a later pull compares against. */
const baselineOf = (cols: { name: string; type: string }[], names: string[]): Baseline => cols.filter((c) => names.includes(c.name)).map((c) => ({ name: c.name, type: c.type }));

/**
 * The columns of `from` checked against the spec (driftOf); a misfit pauses the source. Saves the baseline on the first
 * pull of a version. Answers why it no longer fits, or null.
 */
async function checkColumns(s: Scope, on: Tx, l: Loaded, c: Connector, from: From, keyset: string[]): Promise<Drift | null> {
  const names = [...l.spec.fields.map((f) => f.name), ...keyset];
  const cols = await c.introspect(from);
  const baseline = l.cursor?.columnsVersionId === l.versionId ? (l.cursor.columns as Baseline) : null;
  const drift = driftOf(cols, l.spec.fields, keyset, baseline, "table" in from ? `table ${from.table}` : "the query", (t) => familyOf(l.conn!.engine as DbEngine, t));
  if (drift) return drift;
  if (!baseline) await inScope(s, on, (tx) => setCursor(tx, s, { columns: baselineOf(cols, names), columnsVersionId: l.versionId }));
  return null;
}

/**
 * One watermark pull of a db_watermark source (spec §8, S7): from the stored (watermark, id) less the lookback, keyset
 * pages of `chunk` rows; each page's rows and the watermark after it commit together. Answers "skipped" for a source
 * that isn't active, has no published version or connection, or isn't of this space.
 */
export async function pullSource(s: Scope, on: Tx): Promise<"pulled" | "paused" | "failed" | "skipped"> {
  const l = await inScope(s, on, (tx) => load(tx, s));
  if (!l || l.status !== "active" || l.spec.input.kind !== "db_watermark" || !l.conn) return "skipped";
  const input = l.spec.input;
  const from: From = input.table !== undefined ? { table: input.table } : { query: input.query! };
  const wm = input.watermark;
  const c = ingestHooks.connect(l.conn);
  try {
    const drift = await checkColumns(s, on, l, c, from, [wm.column, wm.id_column]);
    if (drift) {
      await inScope(s, on, (tx) => pause(tx, s, drift.message, drift.columns));
      return "paused";
    }
    const wmField = l.spec.fields.find((f) => f.name === wm.column);
    const after = l.cursor?.watermark != null && l.cursor.watermarkId != null ? { wm: l.cursor.watermark, id: l.cursor.watermarkId } : null;
    const origin: Origin = { origin: "pull", originId: Bun.randomUUIDv7(), snapshotId: null, text: (cells) => JSON.stringify(cells) };
    const counts = newCounts();
    let n = 0;
    for await (const page of c.pullWatermark({ from, columns: l.spec.fields.map((f) => f.name), watermark: wm, after, lookbackSeconds: input.lookback_seconds, chunk: input.chunk })) {
      const last = page[page.length - 1]!;
      const mark = { watermark: last[wm.column]!, watermarkId: last[wm.id_column]! };
      const lines = page.map((raw) => ({ line: ++n, ok: true as const, raw }));
      await withPartitions(on, () => inScope(s, on, async (tx) => {
        await sourceLock(tx, s.sourceId);
        await writeLines(tx, s, l, origin, lines, counts);
        await setCursor(tx, s, { ...mark, lastSuccessAt: new Date(), lastError: null }, completeThroughOf(mark.watermark, input.lookback_seconds, wmField));
      }));
    }
    if (!n) await inScope(s, on, (tx) => setCursor(tx, s, { lastSuccessAt: new Date(), lastError: null }));
    return "pulled";
  } catch (e) {
    return connectorFailed(s, on, e);
  } finally {
    await c.close();
  }
}

/**
 * Snapshot of `businessDate` for a db_snapshot source (spec §8): loaded under a `loading` snapshot, made active only
 * when the whole query was read, superseding the active one in the same transaction. A failure marks it failed and
 * leaves the active one as it was. A closed day is not pulled again ("day_closed": Plan 5's rerun with approval).
 */
export async function snapshotSource(s: Scope, businessDate: string, on: Tx): Promise<"active" | "failed" | "paused" | "skipped" | "day_closed"> {
  const l = await inScope(s, on, (tx) => load(tx, s));
  if (!l || l.status !== "active" || l.spec.input.kind !== "db_snapshot" || !l.conn) return "skipped";
  const query = l.spec.input.query;
  const id = Bun.randomUUIDv7();
  const ofDate = and(eq(sourceSnapshots.spaceId, s.spaceId), eq(sourceSnapshots.sourceId, s.sourceId), eq(sourceSnapshots.businessDate, businessDate));
  const started = await inScope(s, on, async (tx) => {
    await sourceLock(tx, s.sourceId);
    if (await ingestHooks.dayClosed(tx, s, businessDate)) return false;
    // a loading one now is from a worker that died: the job of this source and date runs once at a time (stately key)
    await tx.update(sourceSnapshots).set({ status: "failed", error: "Stopped before it finished.", finishedAt: NOW }).where(and(ofDate, eq(sourceSnapshots.status, "loading")));
    await tx.insert(sourceSnapshots).values({ id, ...s, businessDate, status: "loading" });
    return true;
  });
  if (!started) return "day_closed";
  const counts = newCounts();
  const c = ingestHooks.connect(l.conn);
  let drift: Drift | null = null;
  try {
    drift = await checkColumns(s, on, l, c, { query, businessDate }, []);
    if (drift) throw new ConnectorError("spec", null, drift.message);
    const origin: Origin = { origin: "snapshot", originId: id, snapshotId: id, businessDate, text: (cells) => JSON.stringify(cells) };
    let n = 0;
    for await (const page of c.pullSnapshot(query, businessDate, { columns: l.spec.fields.map((f) => f.name), chunk: SNAPSHOT_CHUNK })) {
      const lines = page.map((raw) => ({ line: ++n, ok: true as const, raw }));
      await withPartitions(on, () => inScope(s, on, (tx) => writeLines(tx, s, l, origin, lines, counts)));
    }
    const kept = await inScope(s, on, async (tx) => {
      await sourceLock(tx, s.sourceId);
      // a pull that gave no record never replaces a date that has data: no rows (an empty table, a wrong filter, a day
      // not loaded yet), or every row quarantined (a changed format, a wrong column); its quarantined lines stay
      if (counts.ok === 0) {
        const [active] = await tx.select({ rows: sourceSnapshots.rows }).from(sourceSnapshots).where(and(ofDate, eq(sourceSnapshots.status, "active")));
        if (active && active.rows > 0) {
          const error = n === 0 ? EMPTY_SNAPSHOT : QUARANTINED_SNAPSHOT;
          await tx.update(sourceSnapshots).set({ status: "failed", error, finishedAt: NOW }).where(eq(sourceSnapshots.id, id));
          await setCursor(tx, s, { lastError: `Snapshot ${businessDate}: ${error}` });
          return true;
        }
      }
      await tx.update(sourceSnapshots).set({ status: "superseded" }).where(and(ofDate, eq(sourceSnapshots.status, "active")));
      await tx.update(sourceSnapshots).set({ status: "active", rows: counts.added, finishedAt: NOW }).where(eq(sourceSnapshots.id, id));
      // the date's records are this snapshot's alone now (a snapshot source has no others): set, not add
      await tally(tx, s, "records", new Map([[businessDate, counts.added]]), true);
      await setCursor(tx, s, { lastSuccessAt: new Date(), lastError: null }, endOfDay(businessDate));
      return false;
    });
    return kept ? "failed" : "active";
  } catch (e) {
    const reason = e instanceof ConnectorError ? e.message : "The snapshot stopped on an unexpected error.";
    await inScope(s, on, (tx) => tx.update(sourceSnapshots).set({ status: "failed", rows: counts.added, error: reason, finishedAt: NOW })
      .where(and(eq(sourceSnapshots.id, id), eq(sourceSnapshots.status, "loading"))));
    return connectorFailed(s, on, e, `Snapshot ${businessDate}: `, drift);
  } finally {
    await c.close();
  }
}

/** The complete files of a file_inbox source's folder not seen yet (by name, size and time), with their sha256. */
export async function scanSource(s: Scope, on: Tx, now = Date.now()): Promise<InboxFile[]> {
  const l = await inScope(s, on, (tx) => load(tx, s));
  if (!l || l.status !== "active" || l.spec.input.kind !== "file_inbox") return [];
  let found;
  try {
    found = await completeFiles(loadWorkerConfig(process.env).INBOX_ROOTS, l.spec.input, now);
  } catch (e) {
    if (!(e instanceof InboxError)) throw e;
    await inScope(s, on, (tx) => setCursor(tx, s, { lastError: e.message }));
    return [];
  }
  if (!found.length) return [];
  const seen = await inScope(s, on, (tx) => tx.select({ name: sourceFiles.name, size: sourceFiles.size, at: sourceFiles.modifiedAt }).from(sourceFiles)
    .where(and(eq(sourceFiles.spaceId, s.spaceId), eq(sourceFiles.sourceId, s.sourceId), inArray(sourceFiles.name, found.map((f) => f.name)))));
  const key = (name: string, size: number, at: number) => `${name}\u0000${size}\u0000${at}`;
  const known = new Set(seen.map((x) => key(x.name, x.size, x.at.getTime())));
  const out: InboxFile[] = [];
  for (const f of found.filter((x) => !known.has(key(x.name, x.size, x.modifiedAt)))) {
    out.push({ name: f.name, size: f.size, modifiedAt: f.modifiedAt, sha256: await sha256Of(Bun.file(f.path).stream()) });
  }
  return out;
}

/** A fault of the whole file: it is recorded failed with `message`; `schema` = its layout changed, which also pauses the source (with `drift` per column when known). */
class FileFailure extends Error {
  constructor(message: string, readonly schema: boolean, readonly drift: DriftColumn[] | null = null) { super(message); }
}

/** The bytes of a stream, hashed as they pass. */
async function* hashed(src: AsyncIterable<Uint8Array>, h: Bun.CryptoHasher): AsyncGenerator<Uint8Array> {
  for await (const b of src) { h.update(b); yield b; }
}

/**
 * Ingests one file the scan found (spec §7 step 3a): the same content as an ingested file → `rejected` "Same file
 * already ingested"; a known name with new content → its next version. All its rows, its quarantine and its
 * source_files row commit together. A quote never closed, a line over 1 MB or a header of another width or names → `failed`,
 * nothing of it written (the header case pauses the source too). The same arrival again → "skipped".
 */
export async function ingestFile(s: Scope, f: InboxFile, on: Tx): Promise<"ingested" | "rejected" | "failed" | "skipped"> {
  const l = await inScope(s, on, (tx) => load(tx, s));
  if (!l || l.status !== "active" || l.spec.input.kind !== "file_inbox") return "skipped";
  const input = l.spec.input;
  let file: string;
  try {
    file = await inboxFile(loadWorkerConfig(process.env).INBOX_ROOTS, input.path, f.name);
  } catch (e) {
    if (!(e instanceof InboxError)) throw e;
    await inScope(s, on, (tx) => setCursor(tx, s, { lastError: e.message }));
    return "skipped";
  }
  const row = { id: Bun.randomUUIDv7(), ...s, name: f.name, sha256: f.sha256, size: f.size, modifiedAt: new Date(f.modifiedAt), businessDate: fileDateOf(f.name) };
  const mine = and(eq(sourceFiles.spaceId, s.spaceId), eq(sourceFiles.sourceId, s.sourceId));
  try {
    return await withPartitions(on, () => inScope(s, on, async (tx) => {
      await sourceLock(tx, s.sourceId);
      const [arrived] = await tx.select({ id: sourceFiles.id }).from(sourceFiles)
        .where(and(mine, eq(sourceFiles.name, f.name), eq(sourceFiles.size, f.size), eq(sourceFiles.modifiedAt, row.modifiedAt)));
      if (arrived) return "skipped" as const;
      const [same] = await tx.select({ id: sourceFiles.id }).from(sourceFiles).where(and(mine, eq(sourceFiles.sha256, f.sha256), eq(sourceFiles.status, "ingested")));
      if (same) {
        await tx.insert(sourceFiles).values({ ...row, status: "rejected", reason: "Same file already ingested", versionOf: same.id });
        return "rejected" as const;
      }
      const [prev] = await tx.select({ id: sourceFiles.id, version: sourceFiles.version }).from(sourceFiles)
        .where(and(mine, eq(sourceFiles.name, f.name), eq(sourceFiles.status, "ingested"))).orderBy(desc(sourceFiles.version)).limit(1);
      const origin: Origin = { origin: "file", originId: row.id, snapshotId: null, fileName: f.name, text: (cells) => cells.join(input.format.delimiter) };
      const counts = newCounts();
      const h = new Bun.CryptoHasher("sha256");
      let batch: Line[] = [];
      for await (const line of parseDelimited(hashed(Bun.file(file).stream(), h), input.format, l.spec.fields.map((x) => x.name))) {
        if (!line.ok && line.fatal) throw new FileFailure(Object.values(line.reasons)[0] ?? "The file can't be read.", line.fatal === "schema", line.drift);
        batch.push(line);
        if (batch.length >= FILE_BATCH) { await writeLines(tx, s, l, origin, batch, counts); batch = []; }
      }
      if (batch.length) await writeLines(tx, s, l, origin, batch, counts);
      // a file still being written when the scan hashed it: not recorded, so its next arrival is read again
      if (h.digest("hex") !== f.sha256) throw new Error("ingest: the file changed after the scan hashed it");
      await tx.insert(sourceFiles).values({
        ...row, status: "ingested", version: (prev?.version ?? 0) + 1, versionOf: prev?.id ?? null,
        rowsTotal: counts.total, rowsOk: counts.ok, rowsNew: counts.added, rowsQuarantined: counts.quarantined,
      });
      await setCursor(tx, s, { lastSuccessAt: new Date(), lastError: null }, row.businessDate ? endOfDay(row.businessDate) : null);
      return "ingested" as const;
    }));
  } catch (e) {
    if (!(e instanceof FileFailure)) throw e;
    await inScope(s, on, async (tx) => {
      await sourceLock(tx, s.sourceId);
      await tx.insert(sourceFiles).values({ ...row, status: "failed", reason: e.message }).onConflictDoNothing();
      if (e.schema) await pause(tx, s, `${f.name}: ${e.message}`, e.drift);
    });
    return "failed";
  }
}

/**
 * A scheduled run of a source (queue ingest.pull): a watermark source pulls; a file inbox source scans its folder and
 * queues each new file (ingest.file, one job per source and sha256); a snapshot source queues the snapshot of the
 * business day before today in its calendar (ingest.snapshot, one job per source and date).
 */
export async function runSource(s: Scope, on: Tx, now = new Date()): Promise<void> {
  const l = await inScope(s, on, (tx) => load(tx, s));
  if (!l || l.status !== "active") return;
  if (l.spec.input.kind === "db_watermark") await pullSource(s, on);
  else if (l.spec.input.kind === "file_inbox") {
    for (const f of await scanSource(s, on, now.getTime())) await enqueue(QUEUES.ingestFile, { ...s, file: f }, { key: `${s.sourceId}:${f.sha256}` });
  } else {
    const businessDate = previousBusinessDay(l.calendar, todayIn(now));
    await enqueue(QUEUES.ingestSnapshot, { ...s, businessDate }, { key: `${s.sourceId}:${businessDate}` });
  }
}

/** Schedules source `s`'s runs (queue ingest.pull, keyed by the source): a snapshot source on its cron, others every minute. */
export async function scheduleSource(s: Scope, spec: SourceSpec): Promise<void> {
  await scheduleEvery(QUEUES.ingestPull, s.sourceId, spec.input.kind === "db_snapshot" ? spec.input.schedule : EVERY_MINUTE, s);
}

/** maintenance.partitions: this month and the next two of raw_rows and records, so ingest never has to make one. */
export async function ensureIngestPartitions(on: Tx, now = new Date()): Promise<void> {
  await on.transaction(async (tx) => {
    await ensureMonthPartitions(tx, rawRows, now, 3);
    await ensureMonthPartitions(tx, records, now, 3);
  });
}

/** The job handlers of ingest, on the worker's pool `on` (src/worker.ts passes workerDb). */
export const ingestHandlers = (on: Tx): Partial<Record<QueueName, JobHandler>> => ({
  [QUEUES.ingestPull]: async ({ data }) => { await runSource(data as Scope, on); },
  [QUEUES.ingestFile]: async ({ data }) => {
    const d = data as Scope & { file: InboxFile };
    await ingestFile({ spaceId: d.spaceId, sourceId: d.sourceId }, d.file, on);
  },
  [QUEUES.ingestSnapshot]: async ({ data }) => {
    const d = data as Scope & { businessDate: string };
    await snapshotSource({ spaceId: d.spaceId, sourceId: d.sourceId }, d.businessDate, on);
  },
  [QUEUES.maintenancePartitions]: async () => { await ensureIngestPartitions(on); },
});

// ------------------------------------------------------------------------------------------------ read model
// What the sources screens show of each source (the sources module's list and detail call it): its health through
// sourceHealth, the records and quarantined lines of the business date that health judges, the next scheduled run and
// a paused source's drift. A fixed number of queries for a whole page of sources, never one per source.

/** A source as the sources list reads it: `spec` = its published version's (null = none yet). */
export type ReadSource = { id: string; spaceId: string; kind: SourceKind; status: SourceStatus; spec: SourceSpec | null };
export type SourceState = Pick<SourceDto, "health" | "rowsToday" | "quarantinedToday" | "nextRunAt" | "drift">;
const NO_STATE: SourceState = { health: null, rowsToday: null, quarantinedToday: null, nextRunAt: null, drift: null };

/** Health inputs a source's recons set (recon's reconHealthInputs), by source id. */
export type HealthInputs = Map<string, { graceMinutes: number | null; deadline: string | null }>;
/** The stricter of two inputs: the smaller grace, the earlier deadline (HH:MM compares as text); null = not set. */
const stricter = <T extends number | string>(a: T | null, b: T | null): T | null => (a === null ? b : b === null ? a : b < a ? b : a);

/**
 * The state of each of `list` as space `viewer` sees it, by source id. A source without a published version has none.
 * `quarantinedToday` is null for a source shared to `viewer` (its quarantine stays with the owner, 0014 RLS). Health is
 * judged on the stricter of the source's own inputs (its spec's `health`) and those of the recons reading it (`recon`).
 */
export async function sourceStates(tx: InTx, list: ReadSource[], viewer: string, now = new Date(), recon: HealthInputs = new Map()): Promise<Map<string, SourceState>> {
  const out = new Map(list.map((x) => [x.id, NO_STATE]));
  const pub = list.filter((x): x is ReadSource & { spec: SourceSpec } => x.spec !== null);
  if (!pub.length) return out;
  const ids = pub.map((x) => x.id);
  const cals = await tx.select({ code: calendars.code, weekend: calendars.weekend, holidays: calendars.holidays }).from(calendars)
    .where(inArray(calendars.code, [...new Set(pub.map((x) => x.spec.calendar))]));
  const calOf = new Map(cals.map((c) => [c.code, makeCalendar(c)]));
  const cursors = new Map((await tx.select().from(sourceCursors).where(inArray(sourceCursors.sourceId, ids))).map((c) => [c.sourceId, c]));
  const snaps = await tx.select({ id: sourceSnapshots.sourceId, date: max(sourceSnapshots.businessDate) }).from(sourceSnapshots)
    .where(and(inArray(sourceSnapshots.sourceId, ids), eq(sourceSnapshots.status, "active"))).groupBy(sourceSnapshots.sourceId);
  const files = await tx.select({ id: sourceFiles.sourceId, date: max(sourceFiles.businessDate) }).from(sourceFiles)
    .where(and(inArray(sourceFiles.sourceId, ids), eq(sourceFiles.status, "ingested"))).groupBy(sourceFiles.sourceId);
  const latest = new Map([...snaps, ...files].map((r) => [r.id, r.date]));
  const today = todayIn(now);
  const judged = pub.flatMap((x) => {
    const calendar = calOf.get(x.spec.calendar);
    if (!calendar) return [];
    const c = cursors.get(x.id);
    const own = x.spec.health ?? {}, r = recon.get(x.id);
    const graceMinutes = stricter(own.graceMinutes ?? null, r?.graceMinutes ?? null), deadline = stricter(own.deadline ?? null, r?.deadline ?? null);
    const h = sourceHealth({
      kind: x.kind, status: x.status, lastError: c?.lastError ?? null, completeThrough: c?.completeThrough ?? null, calendar,
      latestActiveDate: latest.get(x.id) ?? null, graceSeconds: graceMinutes === null ? null : graceMinutes * 60,
      deadline: deadline === null ? null : deadlineOn(today, deadline),
    }, now);
    return [{ x, c, health: { ...h, lastError: c?.lastError ?? null, graceMinutes, deadline } }];
  });
  if (!judged.length) return out;
  // the day counters (schema.ts sourceDayCounts); a shared source's quarantined counter is not readable here (0019 RLS)
  const c = sourceDayCounts;
  const counted = await tx.select({ id: c.sourceId, kind: c.kind, n: c.n }).from(c)
    .where(or(...judged.map((j) => and(eq(c.spaceId, j.x.spaceId), eq(c.sourceId, j.x.id), eq(c.businessDate, j.health.businessDate)))));
  const rows = new Map(counted.filter((r) => r.kind === "records").map((r) => [r.id, r.n]));
  const quarantined = new Map(counted.filter((r) => r.kind === "quarantined").map((r) => [r.id, r.n]));
  for (const { x, c, health } of judged) {
    const cron = x.spec.input.kind === "db_snapshot" ? x.spec.input.schedule : EVERY_MINUTE;
    out.set(x.id, {
      health,
      rowsToday: rows.get(x.id) ?? 0,
      quarantinedToday: x.spaceId === viewer ? (quarantined.get(x.id) ?? 0) : null,
      nextRunAt: x.status === "active" ? nextRunOf(cron, now).toISOString() : null,
      drift: x.status === "paused" && c?.drift ? { checkedAt: c.updatedAt.toISOString(), columns: c.drift as DriftColumn[] } : null,
    });
  }
  return out;
}

/**
 * Rebuilds the day counters of space `spaceId` from its rows, as count(*) would give them: for rows written without
 * the pipeline (the demo seed, tests). Ingest keeps them itself (tally).
 */
export async function recountDays(tx: InTx, spaceId: string): Promise<void> {
  const c = sourceDayCounts;
  await tx.delete(c).where(eq(c.spaceId, spaceId));
  await tx.insert(c).select(tx.select({
    spaceId: records.spaceId, sourceId: records.sourceId, businessDate: records.businessDate, kind: sql<string>`'records'`.as("kind"), n: count().as("n"),
  }).from(records).where(and(eq(records.spaceId, spaceId), currentRecord(tx))).groupBy(records.spaceId, records.sourceId, records.businessDate));
  const lineDate = sql<string>`coalesce(${quarantineRows.businessDate}, (${quarantineRows.createdAt} at time zone ${DEFAULT_TIMEZONE})::date)`;
  await tx.insert(c).select(tx.select({
    spaceId: quarantineRows.spaceId, sourceId: quarantineRows.sourceId, businessDate: lineDate.as("business_date"), kind: sql<string>`'quarantined'`.as("kind"), n: count().as("n"),
  }).from(quarantineRows).where(eq(quarantineRows.spaceId, spaceId)).groupBy(sql`1`, sql`2`, sql`3`)); // by position: the zone is a bound parameter, twice it would be two expressions
}

// ------------------------------------------------------------------------------------------------ routes
// GET …/sources/:sourceId/files, /snapshots (the space's own sources and those shared to it, newest first),
// /quarantine (own sources only: rejected lines are the owner's to fix), POST …/run (source_admin, own source).

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** Source `id` as `spaceId` may read it (its own, or shared to it unless `ownOnly`); 404 otherwise. */
async function readable(tx: InTx, spaceId: string, id: string, ownOnly: boolean) {
  const shared = exists(tx.select(one).from(sourceShares).where(and(eq(sourceShares.spaceId, sources.spaceId), eq(sourceShares.sourceId, sources.id), eq(sourceShares.toSpaceId, spaceId))));
  const [s] = await tx.select({ id: sources.id, spaceId: sources.spaceId, name: sources.name, kind: sources.kind, status: sources.status }).from(sources)
    .where(and(eq(sources.id, id), ownOnly ? eq(sources.spaceId, spaceId) : or(eq(sources.spaceId, spaceId), shared)));
  if (!s) throw notFound("source");
  return s;
}
const day = (d: string | null) => d;
const iso = (d: Date | null) => d?.toISOString() ?? null;

export function filePage(ctx: Ctx, id: string, q: IngestListQuery): Promise<Page<SourceFileDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await readable(tx, spaceId, id, false);
    const where = and(eq(sourceFiles.spaceId, s.spaceId), eq(sourceFiles.sourceId, s.id));
    return pageQuery({
      rows: tx.select().from(sourceFiles).where(where).$dynamic(), count: tx.select(one).from(sourceFiles).where(where).$dynamic(),
      orderBy: [desc(sourceFiles.receivedAt), desc(sourceFiles.id)], query: q, on: tx,
      map: (f) => ({
        id: f.id, name: f.name, sha256: f.sha256, size: f.size, status: f.status as SourceFileDto["status"], reason: f.reason, version: f.version, versionOf: f.versionOf,
        businessDate: day(f.businessDate), rowsTotal: f.rowsTotal, rowsOk: f.rowsOk, rowsNew: f.rowsNew, rowsQuarantined: f.rowsQuarantined, receivedAt: f.receivedAt.toISOString(),
      }),
    });
  });
}

export function snapshotPage(ctx: Ctx, id: string, q: IngestListQuery): Promise<Page<SourceSnapshotDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await readable(tx, spaceId, id, false);
    const where = and(eq(sourceSnapshots.spaceId, s.spaceId), eq(sourceSnapshots.sourceId, s.id));
    const page = await pageQuery({
      rows: tx.select().from(sourceSnapshots).where(where).$dynamic(), count: tx.select(one).from(sourceSnapshots).where(where).$dynamic(),
      orderBy: [desc(sourceSnapshots.businessDate), desc(sourceSnapshots.startedAt), desc(sourceSnapshots.id)], query: q, on: tx,
      map: (x) => ({
        id: x.id, businessDate: x.businessDate, status: x.status as SourceSnapshotDto["status"], rows: x.rows, error: x.error,
        startedAt: x.startedAt.toISOString(), finishedAt: iso(x.finishedAt),
      }),
    });
    // ponytail: one dayClosed call per distinct date of the page (≤ 100), a no-op until Plan 5; a set-based hook if it reads a table then
    const closed = new Map<string, boolean>();
    for (const d of new Set(page.items.map((x) => x.businessDate))) closed.set(d, await ingestHooks.dayClosed(tx, { spaceId: s.spaceId, sourceId: s.id }, d));
    return { ...page, items: page.items.map((x) => ({ ...x, closed: closed.get(x.businessDate) ?? false })) };
  });
}

export function quarantinePage(ctx: Ctx, id: string, q: IngestListQuery): Promise<Page<QuarantineRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await readable(tx, spaceId, id, true);
    const where = and(eq(quarantineRows.spaceId, s.spaceId), eq(quarantineRows.sourceId, s.id));
    // a file's line names its file (origin_id = the source_files row, same space)
    const file = and(eq(quarantineRows.origin, "file"), eq(sourceFiles.spaceId, quarantineRows.spaceId), eq(sourceFiles.id, quarantineRows.originId));
    return pageQuery({
      rows: tx.select({ r: quarantineRows, name: sourceFiles.name, version: sourceFiles.version }).from(quarantineRows).leftJoin(sourceFiles, file).where(where).$dynamic(),
      count: tx.select(one).from(quarantineRows).where(where).$dynamic(),
      orderBy: [desc(quarantineRows.createdAt), desc(quarantineRows.id)], query: q, on: tx,
      map: ({ r, name, version }) => ({
        id: r.id, origin: r.origin as QuarantineRowDto["origin"], originId: r.originId, file: name === null ? null : { name, version }, line: r.lineNo, raw: r.raw,
        reasons: r.reasons as Record<string, string>, businessDate: day(r.businessDate), createdAt: r.createdAt.toISOString(),
      }),
    });
  });
}

/**
 * POST …/run: queues a run of the space's own source now (a pull, or an inbox scan), or for a snapshot source the
 * snapshot of `businessDate` again. 409 `day_closed` for a closed day (a rerun with approval, Plan 5), 409
 * `invalid_state` while paused. A run already waiting takes this one in (queued false, no entry).
 */
export function runSourceNow(ctx: Ctx, id: string, b: RunSourceBody): Promise<RunSourceDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await readable(tx, spaceId, id, true);
    const scope = { spaceId, sourceId: s.id };
    const l = await load(tx, scope);
    if (!l) throw new ApiError("bad_request", "This source has no published version yet. Approve one first.");
    if (s.status === "paused") {
      throw new ApiError("invalid_state", `This source is paused${l.cursor?.lastError ? `: ${l.cursor.lastError}` : ""}. Approve a new version to start it again.`);
    }
    let job: string | null;
    if (s.kind === "db_snapshot") {
      if (!b.businessDate) throw new ApiError("bad_request", "Name the business date to pull again.");
      if (await ingestHooks.dayClosed(tx, scope, b.businessDate)) {
        throw new ApiError("day_closed", `Day ${b.businessDate} is closed. Pulling it again needs a rerun request (later release).`);
      }
      job = await enqueue(QUEUES.ingestSnapshot, { ...scope, businessDate: b.businessDate }, { key: `${s.id}:${b.businessDate}` });
    } else {
      if (b.businessDate) throw new ApiError("bad_request", "Only a snapshot source pulls a business date. Send no date.");
      job = await enqueue(QUEUES.ingestPull, scope, { key: s.id });
    }
    if (job) await recordActivity(tx, ctx, { action: "source.run", target: { type: "source", id: s.id, label: s.name }, after: { businessDate: b.businessDate ?? null } });
    return { queued: job !== null };
  });
}
