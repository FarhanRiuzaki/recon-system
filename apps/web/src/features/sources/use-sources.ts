import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@starterkit/ui/ui/toast";
import type { RunSourceDto, SourceDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { INGEST_KEY, sourceDetail, SOURCES_KEY, spaceDetail } from "@/lib/shared/queries";

export const sourcesHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/sources`;
export const sourceHref = (spaceId: string, id: string) => `${sourcesHref(spaceId)}/${encodeURIComponent(id)}`;
/** Task 7's wizard opens step 2 of a new version with the columns the table has now (Build notes 02, proposed route). */
export const newVersionHref = (spaceId: string, id: string) => `${sourceHref(spaceId, id)}/versions/new?step=2`;

/** Why Pull now is off for a role other than source admin (AGENTS.md §10: every disabled action says why). */
export const RUN_REASON = "Only a source admin of this space starts a pull.";

/** The source as `spaceId` sees it (through a share: the published version only). A 404 is final (no retry). */
export function useSource(spaceId: string, id: string) {
  const { key, url } = sourceDetail(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<SourceDto>(url), retry: retryUnlessNotFound });
}

/** The viewer's roles in the space (the space's own read, prefetched by the page under the spaces key). */
export function useSpaceRoles(spaceId: string) {
  const { key, url } = spaceDetail(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url) }).data?.roles ?? [];
}

/**
 * POST …/run: queues a pull (a snapshot source: of `businessDate`). Pending on the trigger, a result toast, the
 * API's reason on failure (409 day_closed, invalid_state); the source and its ingest tables refresh after.
 */
export function useRunSource(spaceId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (businessDate?: string) => api<RunSourceDto>(`/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(id)}/run`, {
      method: "POST", body: JSON.stringify(businessDate ? { businessDate } : {}),
    }),
    onSuccess: (r) => toast(r.queued ? "Pull queued. The source updates when it finishes." : "A pull was already waiting; it takes this one in."),
    onError: (e) => toast.error(errorText(e)),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: SOURCES_KEY }), qc.invalidateQueries({ queryKey: INGEST_KEY })]),
  });
}
