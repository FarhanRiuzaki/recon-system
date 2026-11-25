"use client";

// The reports feature's one data hook file (AGENTS.md §7): the caller's roles in the space, the active templates the
// Generate dialog offers, and the actions (generate, retry, download links) with their result toasts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReportFileDto, ReportSpec, ReportTemplateDto, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import { api, retryUnlessNotFound } from "@/lib/client/api";
import { REPORTS_KEY, reportTemplate, reportVersions, spaceDetail } from "@/lib/shared/queries";

export const reportsApi = (spaceId: string, rest = "") => `/api/spaces/${encodeURIComponent(spaceId)}/reports${rest}`;
export const reportsHref = (spaceId: string, rest = "") => `/spaces/${encodeURIComponent(spaceId)}/reports${rest}`;

export function useSpaceRoles(spaceId: string) {
  const { key, url } = spaceDetail(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url) }).data?.roles ?? [];
}

/** The space's active templates made on request (the Generate dialog's choices), a recon's when `recon`. */
export function useActiveTemplates(spaceId: string, recon?: string) {
  const url = reportsApi(spaceId, `/templates?pageSize=100&status=active${recon ? `&recon=${encodeURIComponent(recon)}` : ""}`);
  return useQuery({ queryKey: [...REPORTS_KEY, "active", spaceId, recon ?? ""], queryFn: () => api<Page<ReportTemplateDto>>(url) });
}

/** A file's download link: a file with full customer data has its own route (its narrower roles). */
export const downloadHref = (spaceId: string, f: Pick<ReportFileDto, "id" | "masking">) => reportsApi(spaceId, `/files/${encodeURIComponent(f.id)}/${f.masking === "full" ? "download-full" : "download"}`);

export function useReportActions(spaceId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: REPORTS_KEY });
  return {
    generate: (b: { templateId: string; from: string; to: string }) => api<ReportFileDto>(reportsApi(spaceId, "/files"), { method: "POST", body: JSON.stringify(b) }).then(async (f) => { await refresh(); return f; }),
    retry: (id: string) => api<ReportFileDto>(reportsApi(spaceId, `/files/${encodeURIComponent(id)}/retry`), { method: "POST" }).then(async (f) => { await refresh(); return f; }),
    refresh,
  };
}

/** One template and its versions (newest first). */
export function useTemplate(spaceId: string, id: string) {
  const t = reportTemplate(spaceId, id), v = reportVersions(spaceId, id);
  return {
    template: useQuery({ queryKey: t.key, queryFn: () => api<ReportTemplateDto>(t.url), retry: retryUnlessNotFound }),
    versions: useQuery({ queryKey: v.key, queryFn: () => api<Page<ReportVersionDto>>(v.url) }),
  };
}

export type TestResult = { rows: { date: string; status: string; values: Record<string, string | null> }[]; summary: DaySummaryDto[] | null; sampleId: string };
export type DaySummaryDto = { date: string; total: number; byStatus: Record<string, number>; matched: number; breaks: number; matchRate: number | null; breaksByReason: { reason: string; count: number }[] };

/** The template's actions (each refreshes the reports queries). */
export function useTemplateActions(spaceId: string, id: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: REPORTS_KEY });
  const v = (vid: string, rest = "") => reportsApi(spaceId, `/templates/${encodeURIComponent(id)}/versions/${encodeURIComponent(vid)}${rest}`);
  const post = <T,>(url: string, body?: object) => api<T>(url, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => { await refresh(); return r; });
  // one object per template (the draft's autosave effect depends on it); its helpers are rebuilt from the same two ids
  return useMemo(() => ({
    save: (vid: string, b: { name?: string; spec: ReportSpec }) => api<ReportVersionDto>(v(vid), { method: "PATCH", body: JSON.stringify(b) }),
    submit: (vid: string) => post<ReportVersionDto>(v(vid, "/submit")),
    approve: (vid: string, note?: string) => post<ReportVersionDto>(v(vid, "/approve"), { ...(note ? { note } : {}) }),
    reject: (vid: string, note: string) => post<ReportVersionDto>(v(vid, "/reject"), { note }),
    newDraft: () => post<ReportVersionDto>(reportsApi(spaceId, `/templates/${encodeURIComponent(id)}/versions`)),
    retire: () => post<ReportTemplateDto>(reportsApi(spaceId, `/templates/${encodeURIComponent(id)}/retire`)),
    test: (vid: string, b: { from: string; to: string }) => api<TestResult>(v(vid, "/test"), { method: "POST", body: JSON.stringify(b) }),
    refresh,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [spaceId, id]);
}

/** POST …/templates (New report template). */
export const createTemplate = (spaceId: string, b: { configId: string; name: string; start: string }) =>
  api<ReportTemplateDto>(reportsApi(spaceId, "/templates"), { method: "POST", body: JSON.stringify(b) });

/** A Test's sample file as the worker makes it: asked every 2 s until ready or failed. */
export function useSampleState(spaceId: string, sampleId: string | undefined) {
  return useQuery({
    queryKey: [...REPORTS_KEY, "sample", spaceId, sampleId ?? ""], enabled: !!sampleId,
    queryFn: () => api<{ status: string; error: string | null }>(reportsApi(spaceId, `/samples/${encodeURIComponent(sampleId!)}/state`)),
    refetchInterval: (q) => (q.state.data && ["ready", "failed", "removed"].includes(q.state.data.status) ? false : 2000),
  }).data;
}
