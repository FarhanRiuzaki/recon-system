import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "@starterkit/ui/ui/toast";
import type { RollbackPullDto, RunSourceDto, SourceDto, SourceSummaryDto, SourceVersionDetailDto, SourceVersionDto } from "@starterkit/shared/contracts/sources";
import type { SourceKind } from "@starterkit/shared/sources";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { inboxFolders, INGEST_KEY, sourceDetail, SOURCES_KEY, sourceSummary, sourceVersion, spaceDetail } from "@/lib/shared/queries";
import type { InboxFolderListDto } from "@starterkit/shared/contracts/inbox";
import { READ_POLL_MS, READ_WATCH_MAX_MS, readMark, readOutcome } from "./read-watch";

export const sourcesHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/sources`;
export const sourceHref = (spaceId: string, id: string) => `${sourcesHref(spaceId)}/${encodeURIComponent(id)}`;
/** The wizard over a source's open draft (Build notes 02): step 2 by default, step 1 (connection) for a source admin. */
export const newVersionHref = (spaceId: string, id: string, step: 1 | 2 | 3 = 2) => `${sourceHref(spaceId, id)}/versions/new?step=${step}`;
export const newSourceHref = (spaceId: string) => `${sourcesHref(spaceId)}/new?step=1`;
export const versionHref = (spaceId: string, id: string, versionId: string) => `${sourceHref(spaceId, id)}/versions/${encodeURIComponent(versionId)}`;
/** The API path of a source, or of `rest` under it ("/versions"). */
export const sourceApi = (spaceId: string, id: string, rest = "") => `/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(id)}${rest}`;

/** Why a role other than source admin can't add a source (every disabled action says why). */
export const NEW_SOURCE_REASON = "Only a source admin of this space adds sources.";
/** Why a role other than source admin or config maker can't edit a source's fields and mapping. */
export const EDIT_REASON = "Only a source admin or a config maker of this space changes a source.";

/** Why Pull now is off for a role other than source admin (AGENTS.md §10: every disabled action says why). */
export const RUN_REASON = "Only a source admin of this space starts a pull.";

/** The source as `spaceId` sees it (through a share: the published version only). A 404 is final (no retry). */
export function useSource(spaceId: string, id: string, poll: number | false = false) {
  const { key, url } = sourceDetail(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<SourceDto>(url), retry: retryUnlessNotFound, refetchInterval: poll });
}

/**
 * The source page's source, watched to the end of a read the viewer asked for (`watch`: Pull now, a folder check, a
 * rollback that waits for the next pull; read-watch.ts): read again every READ_POLL_MS until what its last read left
 * changes, then every read of it (records, pulls, files, snapshots, the list) once more and the read's outcome a toast.
 * Past READ_WATCH_MAX_MS it stops watching; the history's own refresh shows a read that takes longer.
 */
export function useWatchedSource(spaceId: string, id: string) {
  const qc = useQueryClient();
  const [watching, setWatching] = useState<{ mark: string } | null>(null);
  const [ended, setEnded] = useState<SourceDto | null>(null);
  const q = useSource(spaceId, id, watching ? READ_POLL_MS : false);
  const s = q.data;
  // the read ended: adjusted while rendering (React's "storing information from previous renders"), not in an effect
  if (watching && s && readMark(s) !== watching.mark) {
    setWatching(null);
    setEnded(s);
  }
  useEffect(() => {
    if (!watching) return;
    const t = setTimeout(() => setWatching(null), READ_WATCH_MAX_MS);
    return () => clearTimeout(t);
  }, [watching]);
  useEffect(() => {
    if (!ended) return;
    const o = readOutcome(ended);
    if (o.ok) toast(o.text);
    else toast.error(o.text);
    void Promise.all([qc.invalidateQueries({ queryKey: SOURCES_KEY }), qc.invalidateQueries({ queryKey: INGEST_KEY })]);
  }, [ended, qc]);
  return { q, watching: !!watching, watch: () => { if (s) setWatching({ mark: readMark(s) }); } };
}

/** How many of the space's sources are in each summary state (prefetched by the page). */
export function useSourceSummary(spaceId: string) {
  const { key, url } = sourceSummary(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SourceSummaryDto>(url) });
}

/** The viewer's roles in the space (the space's own read, prefetched by the page under the spaces key). */
/** The space's inbox folders (Inbox files), for the File inbox step's Space folder; undefined while loading or on a failure. */
export function useInboxFolderOptions(spaceId: string) {
  const { key, url } = inboxFolders(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<InboxFolderListDto>(url), retry: false }).data;
}

export function useSpaceRoles(spaceId: string) {
  const { key, url } = spaceDetail(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<SpaceRowDto>(url) }).data?.roles ?? [];
}

/**
 * POST …/run: queues a pull (a snapshot source: of `businessDate`). Pending on the trigger, a result toast, the
 * API's reason on failure (409 day_closed, invalid_state); the source and its ingest tables refresh after.
 */
export function useRunSource(spaceId: string, id: string, kind?: SourceKind, onQueued?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (businessDate?: string) => api<RunSourceDto>(`/api/spaces/${encodeURIComponent(spaceId)}/sources/${encodeURIComponent(id)}/run`, {
      method: "POST", body: JSON.stringify(businessDate ? { businessDate } : {}),
    }),
    onSuccess: (r) => {
      const what = kind === "file_inbox" ? "folder check" : "pull";
      toast(r.queued ? `${what[0]!.toUpperCase()}${what.slice(1)} queued. This page updates when it finishes.` : `A ${what} was already waiting; it takes this one in.`);
      onQueued?.();
    },
    onError: (e) => toast.error(errorText(e)),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: SOURCES_KEY }), qc.invalidateQueries({ queryKey: INGEST_KEY })]),
  });
}

/**
 * POST …/pulls/{pullId}/rollback: that pull and every later one are rolled back by the source's next pull, queued now,
 * which then reads those rows again. Throws the API's reason (the confirmation shows it); Pull history and the source
 * refresh after.
 */
export function useRollbackPull(spaceId: string, id: string, onQueued?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pullId: string) => api<RollbackPullDto>(sourceApi(spaceId, id, `/pulls/${encodeURIComponent(pullId)}/rollback`), { method: "POST", body: "{}" }),
    onSuccess: (r) => {
      toast(`Rollback of ${r.pulls} ${r.pulls === 1 ? "pull" : "pulls"} queued. The next pull removes their rows, then reads them again; this page updates when it finishes.`);
      onQueued?.();
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: SOURCES_KEY }), qc.invalidateQueries({ queryKey: INGEST_KEY })]),
  });
}

/** One version of a source with the names of the people it names. A 404 is final. */
export function useVersion(spaceId: string, id: string, versionId: string) {
  const { key, url } = sourceVersion(spaceId, id, versionId);
  return useQuery({ queryKey: key, queryFn: () => api<SourceVersionDetailDto>(url), retry: retryUnlessNotFound });
}

/**
 * "Edit source": opens the source's open draft in the wizard, or makes one from the published version first (POST
 * …/versions) and then opens it. Pending on the trigger; a failure is a toast with the API's reason.
 */
export function useStartVersion(spaceId: string, id: string) {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => api<SourceVersionDto>(sourceApi(spaceId, id, `/versions`), { method: "POST", body: "{}" }),
    onSuccess: async (v) => {
      await qc.invalidateQueries({ queryKey: SOURCES_KEY });
      router.push(newVersionHref(spaceId, id));
      toast(`Draft version ${v.version} started.`);
    },
    onError: (e) => toast.error(errorText(e)),
  });
}
