import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@starterkit/ui/ui/toast";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDto, ReconVersionDetailDto, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { RECON_KEY, reconDetail, reconVersion, sideSourceOptions, sourceDetail, spaceDetail } from "@/lib/shared/queries";

export const reconsHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/recons`;
export const newReconHref = (spaceId: string) => `${reconsHref(spaceId)}/new`;
export const reconHref = (spaceId: string, id: string) => `${reconsHref(spaceId)}/${encodeURIComponent(id)}`;
export const reconVersionHref = (spaceId: string, id: string, versionId: string) => `${reconHref(spaceId, id)}/versions/${encodeURIComponent(versionId)}`;
/** The API path of the space's recons, or of `rest` under recon `id`. */
export const reconApi = (spaceId: string, id?: string, rest = "") =>
  `/api/spaces/${encodeURIComponent(spaceId)}/recons${id ? `/${encodeURIComponent(id)}` : ""}${rest}`;

/** Why a role other than config maker can't add or change a recon (every disabled action says why). */
export const MAKER_REASON = "Only a config maker of this space changes recons.";
export const NEW_RECON_REASON = "Only a config maker of this space adds recons.";

/** The viewer's roles in the space (the space's own read, prefetched by the page under the spaces key). */
export function useSpaceRoles(spaceId: string) {
  const { key, url } = spaceDetail(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url) }).data?.roles ?? [];
}

/**
 * The recon with its published version and open draft. A 404 is final. Read again when the tab comes back, so a draft
 * saved meanwhile from another tab shows (the builder's notice).
 */
export function useRecon(spaceId: string, id: string) {
  const { key, url } = reconDetail(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<ReconDto>(url), retry: retryUnlessNotFound, refetchOnWindowFocus: true });
}

/** One version of a recon with the names of the people it names. A 404 is final. */
export function useReconVersion(spaceId: string, id: string, versionId: string, enabled = true) {
  const { key, url } = reconVersion(spaceId, id, versionId);
  return useQuery({ queryKey: key, queryFn: () => api<ReconVersionDetailDto>(url), retry: retryUnlessNotFound, enabled });
}

/** A side's source as this space sees it (its published version gives the fields a recon may name). */
export function useSideSource(spaceId: string, sourceId: string) {
  const { key, url } = sourceDetail(spaceId, sourceId);
  return useQuery({ queryKey: key, queryFn: () => api<SourceDto>(url), retry: retryUnlessNotFound });
}

/** The sources a side may read: this space's and those shared to it (first 100, name A–Z). */
export function useSourceOptions(spaceId: string) {
  const { key, url } = sideSourceOptions(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<Page<SourceRowDto>>(url) });
}

/**
 * "Edit recon": a new draft from the published version (POST …/versions), then the builder over it. Pending on the
 * trigger; a failure is a toast with the API's reason.
 */
export function useStartVersion(spaceId: string, id: string) {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => api<ReconVersionDto>(reconApi(spaceId, id, "/versions"), { method: "POST", body: "{}" }),
    onSuccess: async (v) => {
      await qc.invalidateQueries({ queryKey: RECON_KEY });
      router.push(reconHref(spaceId, id));
      toast(`Draft v${v.version} started.`);
    },
    onError: (e) => toast.error(errorText(e)),
  });
}
