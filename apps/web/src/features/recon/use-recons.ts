import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@starterkit/ui/ui/toast";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDto, ReconRunDto, ReconVersionDetailDto, ReconVersionDto, RunRangeBody } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { draftSimulations, RECON_KEY, reconLatestRuns, reconDetail, reconRun, reconVersion, sideSourceOptions, sourceDetail, spaceDetail } from "@/lib/shared/queries";
import { isLive } from "./run-model";

export const reconsHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/recons`;
export const newReconHref = (spaceId: string) => `${reconsHref(spaceId)}/new`;
export const reconHref = (spaceId: string, id: string) => `${reconsHref(spaceId)}/${encodeURIComponent(id)}`;
export const reconRunHref = (spaceId: string, id: string, runId: string) => `${reconHref(spaceId, id)}/runs/${encodeURIComponent(runId)}`;
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

/** The recon's last real run (null: none yet), read while `enabled`. */
export function useLastRun(spaceId: string, id: string, enabled: boolean) {
  const { key, url } = reconLatestRuns(spaceId, id);
  // ponytail: the newest real run among the last 50 runs; a `mode=real` filter on GET …/runs when simulations crowd it out
  return useQuery({ queryKey: key, queryFn: () => api<Page<ReconRunDto>>(url), enabled, select: (p) => p.items.find((r) => r.mode !== "simulation") ?? null });
}

/** How often a queued or running run is read again. */
const POLL_MS = 1500;

/** Failed reads in a row of a run being polled before the screen says it can't reach the server. */
const STALL_AFTER = 3;
/** What a screen says while the polls of a running run keep failing (it goes on polling). */
export const STALL_TEXT = "Can't reach the server. Retrying.";

/**
 * One run of a recon: read again every 1.5 s while the worker has it (queued, running), then left alone. `initial` =
 * the run as a list already gave it (no request after hydration for a run that is over). `stalled` = the last
 * STALL_AFTER reads of a running run failed.
 */
export function useRun(spaceId: string, id: string, runId: string | null, initial?: ReconRunDto) {
  const { key, url } = reconRun(spaceId, id, runId ?? "");
  const q = useQuery({
    queryKey: key, queryFn: () => api<ReconRunDto>(url), enabled: !!runId, retry: retryUnlessNotFound,
    initialData: initial?.id === runId ? initial : undefined, staleTime: (x) => (isLive(x.state.data) ? 0 : Infinity),
    refetchInterval: (x) => (isLive(x.state.data) ? POLL_MS : false),
  });
  // errors since the last good read: the error count when data last arrived, kept per data update
  const [base, setBase] = useState({ at: q.dataUpdatedAt, errors: q.errorUpdateCount });
  if (base.at !== q.dataUpdatedAt) setBase({ at: q.dataUpdatedAt, errors: q.errorUpdateCount });
  const stalled = isLive(q.data) && q.isRefetchError && q.errorUpdateCount - base.errors >= STALL_AFTER;
  return { ...q, stalled };
}

/**
 * A draft's simulation (BUILDER-SPEC "Simulation bar"): its latest run, polled until it is over, the latest one that
 * succeeded (its numbers stay on screen while the next runs), and `start` (POST …/simulate over a business date
 * range). When a run ends, the recon is read again (the draft's simulated state) and `onOver` runs.
 */
export function useSimulation(spaceId: string, id: string, versionId: string, enabled: boolean) {
  const qc = useQueryClient();
  const list = draftSimulations(spaceId, id, versionId);
  const runs = useQuery({ queryKey: list.key, queryFn: () => api<Page<ReconRunDto>>(list.url), enabled });
  const latest = runs.data?.items[0];
  const [startedId, setStartedId] = useState<string | null>(null);
  const runId = startedId ?? latest?.id ?? null;
  const rq = useRun(spaceId, id, runId, latest);
  const run = rq.data ?? null;
  const [shown, setShown] = useState<ReconRunDto | null>(() => runs.data?.items.find((r) => r.status === "succeeded") ?? null);
  if (run?.status === "succeeded" && run !== shown) setShown(run);
  // a run that ends while on screen: read the recon again (simulatedHash) and the list (the next visit's first row)
  const was = useRef(run?.status);
  useEffect(() => {
    const before = was.current;
    was.current = run?.status;
    if (!isLive({ status: before ?? "" }) || isLive(run)) return;
    void qc.invalidateQueries({ queryKey: reconDetail(spaceId, id).key });
    void qc.invalidateQueries({ queryKey: list.key });
  }, [run, qc, spaceId, id, list.key]);
  const start = async (range: RunRangeBody) => {
    const r = await api<ReconRunDto>(reconApi(spaceId, id, `/versions/${encodeURIComponent(versionId)}/simulate`), { method: "POST", body: JSON.stringify(range) });
    qc.setQueryData(reconRun(spaceId, id, r.id).key, r);
    setStartedId(r.id);
    return r;
  };
  return { run, shown, start, stalled: rq.stalled };
}
