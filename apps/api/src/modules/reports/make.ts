// Making report files (spec "Function and flow"): a file row is queued (on request, after a run, or a Test's sample),
// and the worker's `reports.make` job reads the rows, writes the file under the space's inbox root
// (`.reports/<id>.<ext>`, written as `.<id>.part` and renamed when complete, so a half file is never served), records
// its dates' sign-off (Final) and size, and marks it ready or failed. A file row is made once per (template, run).
import { readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { GenerateReportBody, ReportFileDto, ReportPreviewBody, ReportSpec, TestReportBody } from "@starterkit/shared/contracts/reports";
import { parseStoredSpec } from "@starterkit/shared/report-spec";
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
import { reconDays, reconRuns } from "../engine";
import { reconConfigs } from "../recon";
import { spaces, withSpace } from "../spaces";
import { users } from "../users";
import { type Problem, type Renderer, renderRow, rendererOf } from "./cells";
import { type Line, linesOf, type RowIn, rowLine, type Sheet, type SheetCtx, sheetOf, totaller } from "./lines";
import { maskValue } from "./mask";
import { catalogRefs, fieldCatalog } from "./fields";
import { refsOf } from "./formula";
import { reportHtml } from "./pdf-html";
import { datasetRows } from "./rows";
import { reportFiles, reportTemplates, reportVersions } from "./schema";
import { activeVersion, afterRunTemplates, inSpace } from "./service";
import { writeCsvFile, type Written } from "./write-csv";
import { writePdf } from "./write-pdf";
import { txtLines, writeTxt } from "./write-txt";
import { writeXlsx } from "./write-xlsx";

const DAY = 86400_000;
/** The preview's rows (it answers inside the request, one date). */
export const PREVIEW_ROWS = 50;
const EXT = { csv: "csv", xlsx: "xlsx", txt: "txt", pdf: "pdf" } as const;
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
  // the template's row locked first: two requests at once for the same dates count one after the other
  await tx.select({ id: reportTemplates.id }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, templateId))).for("update");
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
    const [own] = await tx.select({ retiredAt: reportTemplates.retiredAt }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, b.templateId)));
    if (!own) throw notFound("report template");
    if (own.retiredAt) throw new ApiError("invalid_state", "This report template is retired, so it makes no more files.");
    const v = await activeVersion(tx, spaceId, b.templateId);
    if (!v) throw new ApiError("invalid_state", "This report has no active version yet. Send its draft first.");
    const spec = parseStoredSpec(v.spec);
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
      await insertFile(tx, { spaceId, templateId: t.templateId, versionId: t.versionId, configId, spec: parseStoredSpec(v!.spec), from, to, askedBy: null, runId, sample: false });
    }
  }, on);
}

/** The rows of `spec` over the dates, rendered (cells masked per `spec.output.masking`), page by page. */
async function* renderedPages(on: Tx, spaceId: string, configId: string, spec: ReportSpec, from: string, to: string, pageSize?: number, forceMask = false): AsyncGenerator<{ rows: RowIn[]; customer: Set<string>; problems: Problem[] }> {
  let i = 0;
  let r: Renderer | null = null;
  for await (const p of datasetRows(on, spaceId, configId, spec, from, to, pageSize)) {
    r ??= rendererOf(spec, p.customer, forceMask);
    const problems: Problem[] = [];
    const rows = p.rows.map((d): RowIn => { const x = renderRow(spec, d, i++, r!); if (x.problems) problems.push(...x.problems); return { ...x, data: d }; });
    yield { rows, customer: p.customer, problems };
  }
}

/** Masks `v` of field `ref` when the file masks and `ref` is customer data (group labels, header lines). */
const maskerOf = (customer: Set<string>, masked: boolean) => (ref: string, v: string) => (masked && customer.has(ref) ? maskValue(v) : v);

/** A masked file's customer-data columns (their sums stay blank) and fields (a header sum over one stays blank). */
const hiddenColumns = (spec: ReportSpec, customer: Set<string>) => (spec.output.masking === "masked" ? rendererOf(spec, customer).customer : new Set<string>());
const hiddenRefs = (spec: ReportSpec, customer: Set<string>) => (spec.output.masking === "masked" ? customer : new Set<string>());

/** The sheet's numbers for the header block: row count, and the sums of the fields its lines total. */
function headerNumbers(spec: ReportSpec, rows: RowIn[]): Pick<SheetCtx, "count" | "sums" | "first"> {
  const sums: Record<string, number> = {};
  for (const l of spec.sections.header.lines) if (l.value.kind === "sum") { const ref = l.value.ref; sums[ref] = rows.reduce((a, r) => a + (typeof r.data.values[ref] === "number" ? (r.data.values[ref] as number) : 0), 0); }
  return { count: rows.length, sums, first: rows[0]?.data ?? null };
}

async function* asPages(lines: Line[]) { yield lines; }

/** Writes the file of row `f` (design `spec`) to `part`; answers what was written. */
async function write(on: Tx, f: FileRow, stored: ReportSpec, part: string, chromium: string, progress: (p: number) => Promise<void>): Promise<Written> {
  const spec: ReportSpec = { ...stored, output: { ...stored.output, masking: f.masking as "masked" | "full" } };
  const dates = datesOf(f.fromDate, f.toDate);
  const pct = (date: string | undefined) => progress(Math.min(95, Math.round(((dates.indexOf(date ?? f.fromDate) + 1) / dates.length) * 95)));
  const n = await withSpace({ spaceIds: [f.spaceId], userId: null }, (tx) => names(tx, f.spaceId, f.configId, f.templateId), on);
  const fd = await finalDates(on, f);
  const base = { ...n, from: f.fromDate, to: f.toDate, madeAt: new Date().toISOString(), final: fd.length > 0 && fd.every((d) => d.final), masking: spec.output.masking };
  const pages = renderedPages(on, f.spaceId, f.configId, spec, f.fromDate, f.toDate);
  const fmt = spec.output.format;
  const flat = !spec.groups.length && !spec.sections.header.lines.some((l) => l.value.kind !== "text" && l.value.kind !== "field");
  if ((fmt === "csv" || fmt === "txt") && flat) {
    // streamed: the rows as they come, the total line from running totals; the header's field lines read the first row
    let first: RowIn | null = null;
    let customer = new Set<string>();
    const it = pages[Symbol.asyncIterator]();
    const head = await it.next();
    if (!head.done) { first = head.value.rows[0] ?? null; customer = head.value.customer; }
    const t = totaller(spec, hiddenColumns(spec, customer));
    const sheet = sheetOf(spec, { ...base, count: 0, sums: {}, first: first?.data ?? null }, maskerOf(customer, spec.output.masking === "masked"), hiddenRefs(spec, customer));
    const lines = (async function* () {
      let p = head;
      while (!p.done) {
        for (const r of p.value.rows) t.add(r);
        yield p.value.rows.map(rowLine);
        await pct(p.value.rows.at(-1)?.data.date);
        p = await it.next();
      }
      if (spec.totals.on && spec.columns.length) yield [t.line()];
    })();
    return fmt === "csv" ? writeCsvFile(lines, sheet, part) : writeTxt(lines, sheet, part);
  }
  const rows: RowIn[] = [];
  let customer = new Set<string>();
  for await (const p of pages) {
    rows.push(...p.rows);
    customer = p.customer;
    if (fmt === "pdf" && spec.dataset !== "recap" && !spec.summaryOnly && rows.length > PDF_ROWS_MAX) throw new ApiError("bad_request", PDF_TOO_MANY);
    await pct(p.rows.at(-1)?.data.date);
  }
  const mask = maskerOf(customer, spec.output.masking === "masked");
  const sheet = sheetOf(spec, { ...base, ...headerNumbers(spec, rows) }, mask, hiddenRefs(spec, customer));
  const lines = linesOf(spec, rows, mask, hiddenColumns(spec, customer));
  if (fmt === "pdf") return { ...(await writePdf(reportHtml(lines, sheet), part, chromium, sheet.footer?.pageNumbers ?? false)), rows: rows.length };
  if (fmt === "xlsx") return writeXlsx(asPages(lines), sheet, part);
  return fmt === "csv" ? writeCsvFile(asPages(lines), sheet, part) : writeTxt(asPages(lines), sheet, part);
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
    return { f, spec: parseStoredSpec(v!.spec), code: s!.code };
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
    // the file's own reasons are final; anything else is thrown so the queue tries again (retryLimit)
    if (!(e instanceof ApiError)) throw e;
  }
}

export const reportsHandlers = (on: Tx): Partial<Record<(typeof QUEUES)[keyof typeof QUEUES], JobHandler>> => ({
  [QUEUES.reportsMake]: async (job) => {
    const d = job.data as { spaceId: string; fileId: string };
    await makeFile(on, d.spaceId, d.fileId);
  },
});

async function versionOf(tx: InTx, spaceId: string, templateId: string, versionId: string) {
  const [t] = await tx.select().from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, templateId)));
  if (!t) throw notFound("report template");
  const [v] = await tx.select().from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.templateId, t.id), eq(reportVersions.id, versionId)));
  if (!v) throw notFound("report version");
  return { t, v };
}

/** POST …/versions/:vid/test: a sample file of `from`..`to`, always masked, queued for the worker (Chromium never runs in the API). */
export function testFile(ctx: Ctx, templateId: string, versionId: string, b: TestReportBody): Promise<{ sampleId: string }> {
  checkRange(b.from, b.to);
  return inSpace(ctx, async (tx, spaceId) => {
    const { t, v } = await versionOf(tx, spaceId, templateId, versionId);
    const spec = parseStoredSpec(v.spec);
    const sample = (await insertFile(tx, { spaceId, templateId: t.id, versionId: v.id, configId: t.configId, spec, from: b.from, to: b.to, askedBy: ctx.user.id, runId: null, sample: true }))!;
    await recordActivity(tx, ctx, { action: "report.make", target: { type: "report", id: t.id, label: t.name }, after: { fileId: sample.id, version: v.version, from: b.from, to: b.to, format: sample.format, masking: "masked", runId: null, sample: true } });
    return { sampleId: sample.id };
  });
}

export type Preview = { columns: { id: string; header: string }[]; lines: { kind: Line["kind"]; cells: string[]; marks: Line["marks"] }[]; sheet: Sheet; text: string[] | null; problems: Problem[]; rows: number };

/**
 * POST …/versions/:vid/preview (the stored design) and …/preview-draft (a draft's unsaved `spec`, its maker's view) on the first PREVIEW_ROWS rows
 * of one date, through the file's own renderer and lines (preview = file), always masked. Reads only.
 */
export function previewReport(ctx: Ctx, templateId: string, versionId: string, b: ReportPreviewBody & { spec?: ReportSpec }): Promise<Preview> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { t, v } = await versionOf(tx, spaceId, templateId, versionId);
    if (b.spec && v.status !== "draft") throw new ApiError("invalid_state", "Only a draft previews unsaved changes.");
    const spec = b.spec ?? parseStoredSpec(v.spec);
    const rows: RowIn[] = [];
    const problems = new Map<string, Problem>();
    let customer = new Set<string>();
    for await (const p of renderedPages(tx, spaceId, t.configId, spec, b.date, b.date, PREVIEW_ROWS, true)) {
      rows.push(...p.rows);
      customer = p.customer;
      for (const x of p.problems) problems.set(x.columnId, x);
      if (rows.length >= PREVIEW_ROWS) break;
    }
    // a column on a field this recon's data doesn't have (an attribute its source dropped) is empty: say so on it
    const known = catalogRefs(await fieldCatalog(tx, spaceId, t.configId, spec.dataset));
    // a source field (a:, b:, item:) the catalog lacks; the recon's own fields are always there
    const lost = (r: string) => /^(a|b|item):/.test(r) && !known.has(r);
    for (const c of spec.columns) {
      const refs = c.content.kind === "field" ? [c.content.ref, ...(c.content.fallback ? [c.content.fallback] : [])] : c.content.kind === "formula" ? refsOf(c.content.cel) : [];
      if (refs.some(lost) && !problems.has(c.id)) problems.set(c.id, { columnId: c.id, message: `${c.header || "A column"}: Field not in the data.` });
    }
    // not a column's: said once each, without a column (the designer shows them above the table)
    const other: Problem[] = [
      ...spec.rows.filters.filter((f) => lost(f.ref)).map((f) => ({ columnId: "", message: `A filter reads a field not in the data: ${f.ref}.` })),
      ...spec.groups.filter(lost).map((g) => ({ columnId: "", message: `Group by reads a field not in the data: ${g}.` })),
    ];
    const n = await names(tx, spaceId, t.configId, t.id);
    const mask = maskerOf(customer, true);
    const masked: ReportSpec = { ...spec, output: { ...spec.output, masking: "masked" } };
    const sheet = sheetOf(masked, { ...n, from: b.date, to: b.date, madeAt: new Date().toISOString(), final: false, masking: "masked", ...headerNumbers(spec, rows.slice(0, PREVIEW_ROWS)) }, mask, hiddenRefs(masked, customer));
    const lines = linesOf(spec, rows.slice(0, PREVIEW_ROWS), mask, hiddenColumns(masked, customer));
    return {
      columns: spec.columns.map((c) => ({ id: c.id, header: c.header })), lines: lines.map((l) => ({ kind: l.kind, cells: l.cells, marks: l.marks })), sheet,
      text: spec.output.format === "txt" ? txtLines(lines, sheet) : null, problems: [...problems.values(), ...other], rows: Math.min(rows.length, PREVIEW_ROWS),
    };
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
    // the report files of the last day's real runs that lack them (the run's hook failed): queued now, once
    const runs = await withSpace(scope, (tx) => tx.select({ id: reconRuns.id, configId: reconRuns.configId, from: reconRuns.dateFrom, to: reconRuns.dateTo }).from(reconRuns)
      .where(and(eq(reconRuns.spaceId, s.id), eq(reconRuns.status, "succeeded"), sql`${reconRuns.mode} <> 'simulation'`, sql`${reconRuns.finishedAt} > ${new Date(now - DAY)}`)), on);
    for (const r of runs) await queueAfterRun(on, s.id, r.configId, r.id, r.from, r.to);
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
