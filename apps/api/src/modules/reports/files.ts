// The Files list (spec "Reports page"): a space's report files, newest first, filtered by recon, template, run,
// Final / Not final, made by (a run or a user) and status. Never a Test's sample.
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReportFileDto, ReportFileListQuery } from "@starterkit/shared/contracts/reports";
import { and, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import { one, pageQuery, sortSql } from "../../kernel/pagination";
import type { Ctx } from "../auth";
import { fileDtos, listedFiles } from "./make";
import { reportFiles } from "./schema";
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
