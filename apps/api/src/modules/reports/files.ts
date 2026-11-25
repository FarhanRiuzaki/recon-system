// The Files list (spec "Reports page"): a space's report files, newest first, filtered by recon, template, run,
// Final / Not final, made by (a run or a user) and status. Never a Test's sample.
import { stat } from "node:fs/promises";
import type { FacetsDto, Page } from "@starterkit/shared/contracts/common";
import type { ReportFileDto, ReportFileListQuery } from "@starterkit/shared/contracts/reports";
import { and, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { config } from "../../kernel/config";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { enqueue, QUEUES } from "../../kernel/jobs";
import { countN, facetOf, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { spaces } from "../spaces";
import { fileDtos, fileOnDisk, listedFiles, reportsDirOf } from "./make";
import { reportFiles, reportTemplates, reportVersions } from "./schema";

type FileRow = typeof reportFiles.$inferSelect;
import { inSpace } from "./service";

export function fileWhere(spaceId: string, q: Omit<ReportFileListQuery, "page" | "pageSize">, except?: "final" | "status" | "madeBy"): SQL | undefined {
  const pick = <T,>(k: string, v: T | undefined) => (k === except ? undefined : v);
  return and(
    listedFiles(spaceId),
    q.recon ? eq(reportFiles.configId, q.recon) : undefined, q.template ? eq(reportFiles.templateId, q.template) : undefined, q.run ? eq(reportFiles.runId, q.run) : undefined,
    pick("final", q.final?.length === 1 ? eq(reportFiles.final, q.final[0] === "final") : undefined),
    pick("status", q.status?.length ? inArray(reportFiles.status, q.status) : undefined),
    pick("madeBy", q.madeBy?.length === 1 ? (q.madeBy[0] === "run" ? isNotNull(reportFiles.runId) : isNull(reportFiles.runId)) : undefined),
  );
}

export function filePage(ctx: Ctx, q: ReportFileListQuery): Promise<Page<ReportFileDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const where = fileWhere(spaceId, q);
    const page = await pageQuery({
      rows: tx.select().from(reportFiles).where(where).$dynamic(), count: tx.select(one).from(reportFiles).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { madeAt: reportFiles.createdAt, from: reportFiles.fromDate }, "-madeAt", reportFiles.id), query: q, map: (r) => r, on: tx,
    });
    return { ...page, items: await fileDtos(tx, spaceId, page.items) };
  });
}

/** GET …/reports/files/facets: files per Final / Not final, status and maker, each with the other filters applied. */
export function fileFacets(ctx: Ctx, q: Omit<ReportFileListQuery, "page" | "pageSize">): Promise<FacetsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const final = sql<string>`case when ${reportFiles.final} then 'final' else 'not_final' end`;
    const made = sql<string>`case when ${reportFiles.runId} is null then 'user' else 'run' end`;
    const [f, s, m] = await Promise.all([
      tx.select({ v: final, n: countN }).from(reportFiles).where(fileWhere(spaceId, q, "final")).groupBy(final),
      tx.select({ v: reportFiles.status, n: countN }).from(reportFiles).where(fileWhere(spaceId, q, "status")).groupBy(reportFiles.status),
      tx.select({ v: made, n: countN }).from(reportFiles).where(fileWhere(spaceId, q, "madeBy")).groupBy(made),
    ]);
    return { final: facetOf(f), status: facetOf(s), madeBy: facetOf(m) };
  });
}

async function ownFile(tx: InTx, spaceId: string, id: string): Promise<FileRow> {
  const [f] = await tx.select().from(reportFiles).where(and(listedFiles(spaceId), eq(reportFiles.id, id)));
  if (!f) throw notFound("report file");
  return f;
}

/** GET …/reports/files/:id. */
export function fileDetail(ctx: Ctx, id: string): Promise<ReportFileDto> {
  return inSpace(ctx, async (tx, spaceId) => (await fileDtos(tx, spaceId, [await ownFile(tx, spaceId, id)]))[0]!);
}

/**
 * GET …/files/:id/download (a masked file) and …/download-full (a file with full customer data, a route of its own so
 * its guard is the narrower role list): the stored bytes as an attachment, an activity entry per download (what file,
 * never its rows).
 */
export async function downloadReport(ctx: Ctx, id: string, full: boolean): Promise<Response> {
  const { f, dir } = await inSpace(ctx, async (tx, spaceId) => {
    const f = await ownFile(tx, spaceId, id);
    if (f.status === "removed") throw new ApiError("invalid_state", `This report was removed after ${config().REPORT_RETENTION_DAYS} days.`);
    if (f.status !== "ready") throw new ApiError("invalid_state", "This report isn't ready yet.");
    if ((f.masking === "full") !== full) throw new ApiError("forbidden", full ? "This report holds masked customer data: download it with Download." : "This report holds full customer data: a space admin, a reviewer or a config checker downloads it.");
    const [s] = await tx.select({ code: spaces.code }).from(spaces).where(eq(spaces.id, spaceId));
    const [t] = await tx.select({ name: reportTemplates.name }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, f.templateId)));
    const [v] = await tx.select({ version: reportVersions.version }).from(reportVersions).where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.id, f.versionId)));
    await recordActivity(tx, ctx, { action: "report.download", target: { type: "report", id: f.templateId, label: t?.name ?? "" }, after: { fileId: f.id, version: v?.version ?? null, from: f.fromDate, to: f.toDate, format: f.format, masking: f.masking, sha256: f.sha256 } });
    return { f, dir: await reportsDirOf(config().INBOX_ROOTS, s!.code, false) };
  });
  const p = fileOnDisk(dir, f);
  if (!(await stat(p).catch(() => null))?.isFile()) throw new ApiError("invalid_state", "The report's file is missing on the server. Make it again.");
  const type = f.format === "csv" ? "text/csv; charset=utf-8" : f.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new Response(Bun.file(p).stream(), { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${f.fileName}"`, "Cache-Control": "no-store" } });
}

/** POST …/files/:id/retry: a failed file queued again (same row, same version). */
export function retryFile(ctx: Ctx, id: string): Promise<ReportFileDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const f = await ownFile(tx, spaceId, id);
    if (f.status !== "failed") throw new ApiError("invalid_state", "Only a report that failed can be made again.");
    const [row] = await tx.update(reportFiles).set({ status: "queued", progress: 0, error: null, updatedAt: sql`now()` }).where(eq(reportFiles.id, f.id)).returning() as [FileRow];
    await enqueue(QUEUES.reportsMake, { spaceId, fileId: f.id }, { key: `${f.id}:${Date.now()}`, tx });
    const [t] = await tx.select({ name: reportTemplates.name }).from(reportTemplates).where(and(eq(reportTemplates.spaceId, spaceId), eq(reportTemplates.id, f.templateId)));
    await recordActivity(tx, ctx, { action: "report.make", target: { type: "report", id: f.templateId, label: t?.name ?? "" }, after: { fileId: f.id, version: null, from: f.fromDate, to: f.toDate, format: f.format, masking: f.masking, runId: f.runId, retry: true } });
    return (await fileDtos(tx, spaceId, [row]))[0]!;
  });
}

/** GET …/reports/samples/:id: a Test's sample file, for its maker only (404 for anyone else). */
export async function downloadSample(ctx: Ctx, id: string): Promise<Response> {
  const { f, dir } = await inSpace(ctx, async (tx, spaceId) => {
    const [f] = await tx.select().from(reportFiles).where(and(eq(reportFiles.spaceId, spaceId), eq(reportFiles.id, id), eq(reportFiles.sample, true), eq(reportFiles.askedBy, ctx.user.id)));
    if (!f) throw notFound("sample");
    if (f.status !== "ready") throw new ApiError("invalid_state", f.status === "failed" ? f.error ?? "The sample failed." : "The sample isn't ready yet.");
    const [s] = await tx.select({ code: spaces.code }).from(spaces).where(eq(spaces.id, spaceId));
    return { f, dir: await reportsDirOf(config().INBOX_ROOTS, s!.code, true) };
  });
  return new Response(Bun.file(fileOnDisk(dir, f)).stream(), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="sample-${f.fileName}"`, "Cache-Control": "no-store" } });
}
