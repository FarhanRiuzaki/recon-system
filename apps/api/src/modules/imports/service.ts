// The Import section's feeds (DEC-066): the logic of /v1/imports/feeds*. 404 → rules → change → activity entry, in one
// transaction per change. A feed may be incomplete while its scheduler is off (Monitoring needs only its history source).
import { eq, ilike, sql } from "drizzle-orm";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ImportFeedBody, ImportFeedDto, ImportFeedListQuery, ImportFeedPatchBody, ImportFeedRowDto, ImportFeedSpec } from "@starterkit/shared/contracts/imports";
import { db, type Tx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { blockers, feedChanges, renamesHistory } from "./rules";
import { importFeeds } from "./schema";
import { historyExists } from "./staging/history-read";

const NOW = sql`now()`;

type Row = typeof importFeeds.$inferSelect;
type TableState = ImportFeedDto["tableState"];

const dto = (r: Row): ImportFeedDto => {
  const spec = r.spec as ImportFeedSpec;
  return {
    id: r.id, name: r.name, kind: "db_host", spec, schedulerOn: r.schedulerOn, tableState: r.tableState as TableState,
    missing: blockers(spec, r.tableState as TableState), updatedAt: r.updatedAt.toISOString(),
  };
};
const rowDto = (r: Row): ImportFeedRowDto => {
  const spec = r.spec as ImportFeedSpec;
  return {
    id: r.id, name: r.name, historySource: spec.historySource, table: spec.table?.name ?? null, schedulerOn: r.schedulerOn,
    runTimes: spec.schedule?.times ?? [], complete: blockers(spec, r.tableState as TableState).length === 0, updatedAt: r.updatedAt.toISOString(),
  };
};
const target = (id: string, name: string) => ({ type: "import_feed", id, label: name });

/** Which unique key a refused write hit: the name or the history source. */
function duplicate(e: unknown): ApiError {
  const pg = ((e as { cause?: { constraint?: string } }).cause ?? e) as { constraint?: string };
  return pg.constraint === "import_feeds_history_source_key"
    ? new ApiError("duplicate", "Another feed already uses this history source. Each source belongs to one feed.")
    : new ApiError("duplicate", "Another feed already has this name. Use a different one.");
}

/** One page of feeds (GET /v1/imports/feeds), name A–Z unless `sort` says otherwise; `q` matches the name. */
export function feedPage(q: ImportFeedListQuery): Promise<Page<ImportFeedRowDto>> {
  const where = q.q?.trim() ? ilike(importFeeds.name, `%${likeEscape(q.q.trim())}%`) : undefined;
  return pageQuery({
    rows: db.select().from(importFeeds).where(where).$dynamic(),
    count: db.select(one).from(importFeeds).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${importFeeds.name})`, updatedAt: importFeeds.updatedAt }, "name", importFeeds.id),
    query: q,
    map: rowDto,
  });
}

/** One feed; null = no such feed. */
export async function feedById(id: string): Promise<ImportFeedDto | null> {
  const [r] = await db.select().from(importFeeds).where(eq(importFeeds.id, id));
  return r ? dto(r) : null;
}

/** Every feed, by name (the monitor reads them all; feeds are few). */
export async function allFeeds(on: Tx = db): Promise<ImportFeedDto[]> {
  return (await on.select().from(importFeeds).orderBy(sql`lower(${importFeeds.name})`, importFeeds.id)).map(dto);
}

/** POST /v1/imports/feeds: a new feed, scheduler off. Name and history source are each unique. */
export async function createFeed(ctx: Ctx, b: ImportFeedBody): Promise<ImportFeedDto> {
  return db.transaction(async (tx) => {
    let row: Row;
    try {
      [row] = await tx.insert(importFeeds).values({ id: Bun.randomUUIDv7(), name: b.name, spec: b.spec, updatedBy: ctx.user.id }).returning() as [Row];
    } catch (e) {
      throw isUniqueViolation(e) ? duplicate(e) : e;
    }
    await recordActivity(tx, ctx, { action: "import.feed_create", target: target(row.id, row.name), after: { name: b.name, spec: b.spec } });
    return dto(row);
  });
}

/** Locks feed `id` for the transaction; its row, or 404. */
async function lockFeed(tx: Tx, id: string): Promise<Row> {
  const [r] = await tx.select().from(importFeeds).where(eq(importFeeds.id, id)).for("update");
  if (!r) throw notFound("import feed");
  return r;
}

/**
 * PATCH /v1/imports/feeds/:id: the name and/or the spec (replaced whole). The history source and batch prefix are what
 * import_file_history is keyed by: once history has a row of the feed's source they can't change (409), or the feed
 * would lose its dates and its lock. Nothing changed → the feed, no entry.
 */
export async function updateFeed(ctx: Ctx, id: string, b: ImportFeedPatchBody): Promise<ImportFeedDto> {
  return db.transaction(async (tx) => {
    const cur = await lockFeed(tx, id);
    const spec = cur.spec as ImportFeedSpec;
    const change = feedChanges({ name: cur.name, spec }, b);
    if (!change) return dto(cur);
    if (b.spec && renamesHistory(spec, b.spec) && await historyExists(spec.historySource)) {
      throw new ApiError("invalid_state", `History already has batches of ${spec.historySource}, so its history source and batch prefix stay as they are.`);
    }
    let row: Row;
    try {
      [row] = await tx.update(importFeeds).set({ ...change.after, updatedAt: NOW, updatedBy: ctx.user.id }).where(eq(importFeeds.id, id)).returning() as [Row];
    } catch (e) {
      throw isUniqueViolation(e) ? duplicate(e) : e;
    }
    await recordActivity(tx, ctx, { action: "import.feed_update", target: target(id, row.name), before: change.before, after: change.after });
    return dto(row);
  });
}

/**
 * DELETE /v1/imports/feeds/:id: refused while its scheduler is on. Its staging table and history stay (they are data,
 * and import-host may still write them); its run and check logs go with it.
 */
export async function deleteFeed(ctx: Ctx, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const cur = await lockFeed(tx, id);
    if (cur.schedulerOn) throw new ApiError("invalid_state", "Turn the feed's scheduler off before deleting it.");
    await tx.delete(importFeeds).where(eq(importFeeds.id, id));
    await recordActivity(tx, ctx, { action: "import.feed_delete", target: target(id, cur.name), before: { name: cur.name, spec: cur.spec } });
  });
}
