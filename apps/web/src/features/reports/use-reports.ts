"use client";

// The reports feature's one data hook file (AGENTS.md §7): the caller's roles in the space, the active templates the
// Generate dialog offers, and the actions (generate, retry, download links) with their result toasts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReportFileDto, ReportTemplateDto } from "@starterkit/shared/contracts/reports";
import { api } from "@/lib/client/api";
import { REPORTS_KEY, spaceDetail } from "@/lib/shared/queries";

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
