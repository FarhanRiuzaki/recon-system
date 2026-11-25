// Making report files (spec "Function and flow"): a file row is queued (on request, after a run, or a Test's sample),
// and the worker's `reports.make` job reads the rows, writes the file under the space's inbox root
// (`.reports/<id>.<ext>`, written as `.<id>.part` and renamed when complete, so a half file is never served), records
// its dates' sign-off (Final) and size, and marks it ready or failed. A file row is made once per (template, run).
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GenerateReportBody, ReportFileDto, ReportSpec, TestReportBody } from "@starterkit/shared/contracts/reports";
import { fileNameOf, PDF_ROWS_MAX, REPORT_RANGE_MAX_DAYS } from "@starterkit/shared/reports";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { config, loadWorkerConfig } from "../../kernel/config";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { ensureInboxDir, spaceRoot } from "../../kernel/inbox-root";
import { enqueue, type JobHandler, QUEUES } from "../../kernel/jobs";
import { log } from "../../kernel/log";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { reconDays } from "../engine";
import { reconConfigs } from "../recon";
import { spaces, withSpace } from "../spaces";
import { users } from "../users";
import { pdfData } from "./pdf-data";
import { reportHtml } from "./pdf-html";
import { reportRows } from "./rows";
import { reportFiles, reportTemplates, reportVersions } from "./schema";
import { activeVersion, afterRunTemplates, inSpace } from "./service";
import { dailySummary, groupRows, type ReportRow } from "./summary";
import { type Column, type Written, writeCsvFile } from "./write-csv";
import { writePdf } from "./write-pdf";
import { writeXlsx } from "./write-xlsx";

const DAY = 86400_000;
/** The Test's bounds (it answers inside the request): a summary of at most 7 dates, rows from at most 10 pages of 500. */
export const TEST_SUMMARY_DAYS = 7;
const TEST_PAGES = 10;
const EXT = { csv: "csv", xlsx: "xlsx", pdf: "pdf" } as const;
type FileRow = typeof reportFiles.$inferSelect;
const PDF_TOO_MANY = `A PDF holds at most ${PDF_ROWS_MAX.toLocaleString("en-US")} rows. Use CSV or Excel for more.`;
const FAILED = "The report stopped on an internal error. Make it again; if it fails again, tell your admin.";

/** Every date of `from`..`to` (yyyy-MM-dd), in order. */
export function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function checkRange(from: string, to: string): void {
  if (to < from) throw new ApiError("bad_request", "The end date is before the start date.");
  if (datesOf(from, to).length > REPORT_RANGE_MAX_DAYS) throw new ApiError("bad_request", `A report covers at most ${REPORT_RANGE_MAX_DAYS} days. Pick a shorter range.`);
}

/** The directory a space's report files live in (made when missing); `roots` = INBOX_ROOTS of this process. */
async function reportsDir(roots: readonly string[], spaceCode: string, sub = ""): Promise<string> {
  const root = spaceRoot(roots, spaceCode);
  if (!root) throw new ApiError("invalid_state", "File inbox isn't set up on this server, so reports have nowhere to be kept.");
  const dir = path.join(root, ".reports", sub);
  await ensureInboxDir(dir);
  return dir;
}
export const fileOnDisk = (dir: string, f: { id: string; format: string }) => path.join(dir, `${f.id}.${EXT[f.format as keyof typeof EXT]}`);
export async function reportsDirOf(roots: readonly string[], spaceCode: string, sample: boolean) { return reportsDir(roots, spaceCode, sample ? "samples" : ""); }

/** The next file version of a template over the same dates. */
async function nextFileVersion(tx: InTx, spaceId: string, templateId: string, from: string, to: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(reportFiles).where(and(eq(reportFiles.spaceId, spaceId), eq(reportFiles.templateId, templateId),
    eq(reportFiles.fromDate, from), eq(reportFiles.toDate, to), eq(reportFiles.sample, false)));
  return (r?.n ?? 0) + 1;
}

async function names(tx: InTx, spaceId: string, configId: string, templateId: string) {
  const [[r], [t]] = await Promise.all([
    tx.select({ name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId))),
    tx.select({ name: reportTemplates.name }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, templateId))),
  ]);
  return { recon: r?.name ?? "", template: t?.name ?? "" };
}

type NewFile = { spaceId: string; templateId: string; versionId: string; configId: string; spec: ReportSpec; from: string; to: string; askedBy: string | null; runId: string | null; sample: boolean };
async function insertFile(tx: InTx, f: NewFile): Promise<FileRow | null> {
  const n = await names(tx, f.spaceId, f.configId, f.templateId);
  const [row] = await tx.insert(reportFiles).values({
    id: Bun.randomUUIDv7(), spaceId: f.spaceId, templateId: f.templateId, versionId: f.versionId, configId: f.configId, fromDate: f.from, toDate: f.to,
    format: f.spec.output.format, masking: f.sample ? "masked" : f.spec.output.masking, status: "queued",
    fileName: `${fileNameOf(f.spec.output.fileName, { ...n, from: f.from, to: f.to })}.${EXT[f.spec.output.format]}`,
    fileVersion: f.sample ? 1 : await nextFileVersion(tx, f.spaceId, f.templateId, f.from, f.to), askedBy: f.askedBy, runId: f.runId, sample: f.sample,
  }).onConflictDoNothing().returning();
  if (row) await enqueue(QUEUES.reportsMake, { spaceId: f.spaceId, fileId: row.id }, { key: row.id, tx });
  return row ?? null;
}

/** POST …/reports/files: a file of an active template over `from`..`to` (≤ 92 days), queued. */
export function requestFile(ctx: Ctx, b: GenerateReportBody): Promise<ReportFileDto> {
  checkRange(b.from, b.to);
  return inSpace(ctx, async (tx, spaceId) => {
    const v = await activeVersion(tx, spaceId, b.templateId);
    if (!v) throw new ApiError("invalid_state", "This report has no active version yet. Send its draft first.");
    const spec = v.spec as ReportSpec;
    if (!spec.when.onRequest) throw new ApiError("invalid_state", "This report is made after runs only. Turn on On request in its template.");
    const [t] = await tx.select().from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, b.templateId)));
    const row = (await insertFile(tx, { spaceId, templateId: t!.id, versionId: v.id, configId: t!.configId, spec, from: b.from, to: b.to, askedBy: ctx.user.id, runId: null, sample: false }))!;
    await recordActivity(tx, ctx, { action: "report.make", target: { type: "report", id: t!.id, label: t!.name }, after: { fileId: row.id, version: v.version, from: b.from, to: b.to, format: row.format, masking: row.masking, runId: null } });
    return (await fileDtos(tx, spaceId, [row]))[0]!;
  });
}

/**
 * After a real run succeeded (the engine calls it after the run's commit): one queued file per active template of the
 * recon marked "after every run", for the run's dates; a run seen again adds nothing (unique per template and run).
 */
export async function queueAfterRun(on: Tx, spaceId: string, configId: string, runId: string, from: string, to: string): Promise<void> {
  const templates = await afterRunTemplates(on, spaceId, configId);
  if (!templates.length) return;
  await withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => {
    for (const t of templates) {
      const [v] = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.id, t.versionId)));
      await insertFile(tx, { spaceId, templateId: t.templateId, versionId: t.versionId, configId, spec: v!.spec as ReportSpec, from, to, askedBy: null, runId, sample: false });
    }
  }, on);
}

/** A report's rows for the template's kind, as the writers take them (a grouped or summary report gathers them). */
function shapeFor(spec: ReportSpec): { columns: Column[] } {
  if (spec.kind !== "daily_summary") return { columns: spec.columns };
  return { columns: [{ key: "date", header: "Business date" }, { key: "total", header: "Results" }, { key: "matched", header: "Matched" }, { key: "breaks", header: "Breaks" }, { key: "rate", header: "Match rate" }] };
}
async function gather(pages: AsyncIterable<ReportRow[]>, max: number | null, onPage: (rows: ReportRow[]) => Promise<void>): Promise<ReportRow[]> {
  const all: ReportRow[] = [];
  for await (const p of pages) {
    all.push(...p);
    if (max !== null && all.length > max) throw new ApiError("bad_request", PDF_TOO_MANY);
    await onPage(p);
  }
  return all;
}
const asPages = async function* (rows: ReportRow[]) { yield rows; };
const summaryRows = (rows: ReportRow[]): ReportRow[] => dailySummary(rows).map((d) => ({
  date: d.date, status: "matched", amount: null, currency: null, reason: null,
  values: { date: d.date, total: String(d.total), matched: String(d.matched), breaks: String(d.breaks), rate: d.matchRate === null ? null : `${(d.matchRate * 100).toFixed(1)}%` },
}));

/** Writes the file of row `f` (version `spec`) to `part`; answers what was written. */
async function write(on: Tx, f: FileRow, spec: ReportSpec, part: string, chromium: string, progress: (p: number) => Promise<void>): Promise<Written> {
  const dates = datesOf(f.fromDate, f.toDate);
  const pct = (rows: ReportRow[]) => progress(Math.min(95, Math.round(((dates.indexOf(rows.at(-1)?.date ?? f.fromDate) + 1) / dates.length) * 95)));
  const pages = reportRows(on, f.spaceId, f.configId, { ...spec, output: { ...spec.output, masking: f.masking as "masked" | "full" } }, f.fromDate, f.toDate);
  const { columns } = shapeFor(spec);
  if (spec.output.format === "pdf") {
    // the limit holds for every PDF but the daily summary (a page per date): a grouped one prints each row too
    const rows = await gather(pages, spec.kind === "daily_summary" ? null : PDF_ROWS_MAX, pct);
    const n = await withSpace({ spaceIds: [f.spaceId], userId: null }, (tx) => names(tx, f.spaceId, f.configId, f.templateId), on);
    const html = reportHtml(pdfData(spec, rows), {
      title: spec.output.title || n.template, subtitle: spec.output.subtitle, recon: n.recon, from: f.fromDate, to: f.toDate,
      dates: await finalDates(on, f), masking: f.masking as "masked" | "full",
    });
    return { ...(await writePdf(html, part, chromium)), rows: rows.length };
  }
  if (spec.kind === "transactions" && spec.output.format === "csv") return writeCsvFile((async function* () { for await (const p of pages) { await pct(p); yield p; } })(), columns, part);
  const rows = await gather(pages, null, pct);
  if (spec.kind === "daily_summary") {
    const out = summaryRows(rows);
    const w = spec.output.format === "csv" ? await writeCsvFile(asPages(out), columns, part) : await writeXlsx(asPages(out), columns, part);
    return { ...w, rows: rows.length };
  }
  if (spec.output.format === "xlsx") return writeXlsx(asPages(rows), columns, part, { groups: spec.groups, totals: spec.totals });
  // a grouped CSV: each group's line (name and totals), its rows, then the Total line
  const shaped = groupRows(rows, spec.groups, spec.totals).map((s): ReportRow => s.kind === "row" ? s.row!
    : { ...rows[0]!, values: { [columns[0]!.key]: `${"  ".repeat(s.level)}${s.label ?? ""}`, ...Object.fromEntries((s.totals ?? []).map((t, i) => [columns[i + 1]?.key ?? `t${i}`, t === null ? null : String(t)])) } });
  const w = await writeCsvFile(asPages(shaped), columns, part);
  return { ...w, rows: rows.length };
}

/** Each date of the file and whether its day was signed off (Final, owner 25 Nov) when read. */
async function finalDates(on: Tx, f: FileRow): Promise<{ date: string; final: boolean }[]> {
  const signed = await withSpace({ spaceIds: [f.spaceId], userId: null }, (tx) => tx.select({ d: sql<string>`${reconDays.businessDate}::text` }).from(reconDays)
    .where(and(eq(reconDays.spaceId, f.spaceId), eq(reconDays.configId, f.configId), sql`${reconDays.businessDate} between ${f.fromDate}::date and ${f.toDate}::date`, sql`${reconDays.signedAt} is not null`)), on);
  const set = new Set(signed.map((s) => s.d));
  return datesOf(f.fromDate, f.toDate).map((date) => ({ date, final: set.has(date) }));
}

/** A file being made whose row hasn't moved for this long is taken as abandoned (its worker died): progress is written every page. */
export const STALE_MS = 15 * 60_000;

/**
 * The worker's handler: makes file `fileId`. A ready or removed file is left as it is; one another worker is making
 * now (its row moved in the last STALE_MS) is too, so two attempts never write one file. Each attempt writes its own
 * part file.
 */
export async function makeFile(on: Tx, spaceId: string, fileId: string, env = loadWorkerConfig(process.env)): Promise<void> {
  const scope = { spaceIds: [spaceId], userId: null };
  const got = await withSpace(scope, async (tx) => {
    const [f] = await tx.select().from(reportFiles).where(and(eq(reportFiles.spaceId, spaceId), eq(reportFiles.id, fileId))).for("update");
    if (!f || f.status === "ready" || f.status === "removed") return null;
    if (f.status === "making" && f.updatedAt.getTime() > Date.now() - STALE_MS) return null;
    const [v] = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.id, f.versionId)));
    const [s] = await tx.select({ code: spaces.code }).from(spaces).where(eq(spaces.id, spaceId));
    await tx.update(reportFiles).set({ status: "making", progress: 0, error: null, readAt: sql`now()`, updatedAt: sql`now()` }).where(eq(reportFiles.id, f.id));
    return { f, spec: v!.spec as ReportSpec, code: s!.code };
  }, on);
  if (!got) return;
  const { f, spec, code } = got;
  const dir = await reportsDirOf(env.INBOX_ROOTS, code, f.sample);
  const part = path.join(dir, `.${f.id}.${Bun.randomUUIDv7()}.part`);
  const set = (patch: Partial<FileRow>) => withSpace(scope, (tx) => tx.update(reportFiles).set({ ...patch, updatedAt: new Date() }).where(eq(reportFiles.id, f.id)), on);
  try {
    const w = await write(on, f, spec, part, env.REPORT_CHROMIUM_PATH, (p) => set({ progress: p }).then(() => {}));
    await rename(part, fileOnDisk(dir, f));
    const dates = await finalDates(on, f);
    await set({ status: "ready", progress: 100, rows: w.rows, size: w.size, sha256: w.sha256, dates, final: dates.every((d) => d.final), readyAt: new Date() });
  } catch (e) {
    await rm(part, { force: true });
    const said = e instanceof ApiError ? e.message : FAILED;
    if (!(e instanceof ApiError)) log.error({ err: e instanceof Error ? { name: e.name } : { type: typeof e }, fileId: f.id }, "report file failed");
    await set({ status: "failed", error: said });
  }
}

export const reportsHandlers = (on: Tx): Partial<Record<(typeof QUEUES)[keyof typeof QUEUES], JobHandler>> => ({
  [QUEUES.reportsMake]: async (job) => {
    const d = job.data as { spaceId: string; fileId: string };
    await makeFile(on, d.spaceId, d.fileId);
  },
});

/**
 * POST …/versions/:vid/test: the first 50 rows (or each date's recap) of `from`..`to`, always masked, answered at once;
 * and a sample file of the same queued for the worker (Chromium never runs in the API), listed nowhere.
 */
export function testFile(ctx: Ctx, templateId: string, versionId: string, b: TestReportBody): Promise<{ rows: ReportRow[]; summary: ReturnType<typeof dailySummary> | null; sampleId: string }> {
  checkRange(b.from, b.to);
  return inSpace(ctx, async (tx, spaceId) => {
    const [t] = await tx.select().from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, templateId)));
    if (!t) throw notFound("report template");
    const [v] = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.templateId, t.id), eq(reportVersions.id, versionId)));
    if (!v) throw notFound("report version");
    const spec = { ...(v.spec as ReportSpec), output: { ...(v.spec as ReportSpec).output, masking: "masked" as const } };
    const rows: ReportRow[] = [];
    // bounded, inside the request: a summary of the first TEST_SUMMARY_DAYS dates; rows from at most TEST_PAGES pages
    const to = spec.kind === "daily_summary" ? datesOf(b.from, b.to).slice(0, TEST_SUMMARY_DAYS).at(-1)! : b.to;
    let pages = 0;
    for await (const p of reportRows(tx, spaceId, t.configId, spec, b.from, to, 500)) {
      rows.push(...p);
      if (++pages >= TEST_PAGES || (spec.kind !== "daily_summary" && rows.length >= 50)) break;
    }
    const sample = (await insertFile(tx, { spaceId, templateId: t.id, versionId: v.id, configId: t.configId, spec, from: b.from, to: b.to, askedBy: ctx.user.id, runId: null, sample: true }))!;
    await recordActivity(tx, ctx, { action: "report.make", target: { type: "report", id: t.id, label: t.name }, after: { fileId: sample.id, version: v.version, from: b.from, to: b.to, format: sample.format, masking: "masked", runId: null, sample: true } });
    const plain = rows.map((r) => ({ ...r, amount: null }));
    return { rows: spec.kind === "daily_summary" ? [] : plain.slice(0, 50), summary: spec.kind === "daily_summary" ? dailySummary(rows) : null, sampleId: sample.id };
  });
}

/** The janitor's part: files past retention removed (row kept, `removed`), samples after 24 h, `.part` leftovers after 1 h. */
export async function purgeReports(on: Tx, now = Date.now()): Promise<{ report_files: number }> {
  const roots = config().INBOX_ROOTS;
  const days = config().REPORT_RETENTION_DAYS;
  let n = 0;
  const all = await on.select({ id: spaces.id, code: spaces.code }).from(spaces);
  for (const s of all) {
    const scope = { spaceIds: [s.id], userId: null };
    const old = await withSpace(scope, (tx) => tx.select().from(reportFiles).where(and(eq(reportFiles.spaceId, s.id), inArray(reportFiles.status, ["ready", "failed"]), sql`(
      (${reportFiles.sample} and ${reportFiles.createdAt} < ${new Date(now - DAY)}) or (not ${reportFiles.sample} and ${reportFiles.createdAt} < ${new Date(now - days * DAY)}))`)).limit(1000), on);
    // a file whose worker died on every attempt (its row unmoved past STALE_MS) is failed, so it can be made again
    await withSpace(scope, (tx) => tx.update(reportFiles).set({ status: "failed", error: FAILED, updatedAt: new Date(now) })
      .where(and(eq(reportFiles.spaceId, s.id), inArray(reportFiles.status, ["queued", "making"]), sql`${reportFiles.updatedAt} < ${new Date(now - 4 * 3600_000)}`)), on);
    if (!spaceRoot(roots, s.code)) continue;
    for (const f of old) {
      const dir = await reportsDirOf(roots, s.code, f.sample);
      await rm(fileOnDisk(dir, f), { force: true });
      await withSpace(scope, (tx) => (f.sample ? tx.delete(reportFiles).where(eq(reportFiles.id, f.id)) : tx.update(reportFiles).set({ status: "removed", removedAt: new Date(now), updatedAt: new Date(now) }).where(eq(reportFiles.id, f.id))), on);
      n++;
    }
    for (const sub of [false, true]) {
      const dir = spaceRoot(roots, s.code) ? await reportsDirOf(roots, s.code, sub) : null;
      if (!dir) continue;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !e.name.endsWith(".part")) continue;
        const st = await stat(path.join(dir, e.name)).catch(() => null);
        if (st && st.mtimeMs < now - 3600_000) { await rm(path.join(dir, e.name), { force: true }); n++; }
      }
    }
  }
  return { report_files: n };
}

/** Rows of report_files as the API answers them. */
export async function fileDtos(tx: InTx, spaceId: string, rows: FileRow[]): Promise<ReportFileDto[]> {
  if (!rows.length) return [];
  const tIds = [...new Set(rows.map((r) => r.templateId))], cIds = [...new Set(rows.map((r) => r.configId))], vIds = [...new Set(rows.map((r) => r.versionId))];
  const uIds = [...new Set(rows.flatMap((r) => (r.askedBy ? [r.askedBy] : [])))];
  const [ts, cs, vs, us] = await Promise.all([
    tx.select({ id: reportTemplates.id, name: reportTemplates.name }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), inArray(reportTemplates.id, tIds))),
    tx.select({ id: reconConfigs.id, name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), inArray(reconConfigs.id, cIds))),
    tx.select({ id: reportVersions.id, version: reportVersions.version }).from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), inArray(reportVersions.id, vIds))),
    uIds.length ? tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uIds)) : Promise.resolve([]),
  ]);
  const by = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
  const [tm, cm, vm, um] = [by(ts), by(cs), by(vs), by(us)];
  return rows.map((r) => ({
    id: r.id, templateId: r.templateId, template: tm.get(r.templateId)?.name ?? "", version: vm.get(r.versionId)?.version ?? 0, configId: r.configId, recon: cm.get(r.configId)?.name ?? "",
    from: r.fromDate, to: r.toDate, format: r.format as ReportFileDto["format"], status: r.status as ReportFileDto["status"], progress: r.progress, final: r.final,
    dates: r.dates as ReportFileDto["dates"], rows: r.rows, size: r.size, masking: r.masking as ReportFileDto["masking"], fileName: r.fileName, fileVersion: r.fileVersion,
    madeBy: r.runId ? { kind: "run" as const, runId: r.runId } : { kind: "user" as const, userId: r.askedBy!, name: um.get(r.askedBy!)?.name ?? "Unknown user" },
    error: r.error, madeAt: r.createdAt.toISOString(), readyAt: r.readyAt?.toISOString() ?? null,
  }));
}

/** A space's files (samples never), newest first, for the Files list (paged by the controller's pageQuery). */
export const listedFiles = (spaceId: string) => and(eq(reportFiles.spaceId, spaceId), eq(reportFiles.sample, false));
