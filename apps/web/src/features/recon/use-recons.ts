import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@starterkit/ui/ui/toast";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import type { BreakSummaryDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDto, ReconLiveDto, ReconRunDto, ReconTrendDto, ReconVersionDetailDto, ReconVersionDto, RunRangeBody, TodayDto } from "@starterkit/shared/contracts/recon";
import type { SourceDto, SourceRowDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { api, errorText, retryUnlessNotFound } from "@/lib/client/api";
import { RECON_KEY, sideSourceOptions, sourceDetail, spaceDetail } from "@/lib/shared/queries";
import { draftSimulations, LIVE_POLL_MS, LIVE_RUN_POLL_MS, MY_APPROVALS_POLL_MS, myApprovals, reconLive, reconOpenSummary, reconTrend, reconDetail, reconRun, reconVersion, spaceToday } from "@/lib/shared/queries-recon";
import { isLive, recordDates, replayGap, suggestedReplay } from "./run-model";
import { appDate } from "@starterkit/ui/lib/format";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";

export const reconsHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/recons`;
export const newReconHref = (spaceId: string) => `${reconsHref(spaceId)}/new`;
export const reconHref = (spaceId: string, id: string) => `${reconsHref(spaceId)}/${encodeURIComponent(id)}`;
/** A recon's Configuration tab: its published spec (a draft's banner says how to continue it). */
export const reconConfigHref = (spaceId: string, id: string) => `${reconHref(spaceId, id)}?tab=configuration`;
/** The setup of a recon's open draft at step `step` (1 Sources … 5 Review and submit). */
export const reconEditHref = (spaceId: string, id: string, step: 1 | 2 | 3 | 4 | 5 | 6) => `${reconHref(spaceId, id)}/versions/new?step=${step}`;
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
      router.push(reconEditHref(spaceId, id, 6)); // the new draft's setup, on Review: every part shown, each with Edit
      toast(`Draft v${v.version} started.`);
    },
    onError: (e) => toast.error(errorText(e)),
  });
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

/**
 * Today (REC-F4): read again every LIVE_POLL_MS while the tab is visible, LIVE_RUN_POLL_MS while a recon's run is
 * queued or under way; every read is the current snapshot.
 */
export function useToday(spaceId: string) {
  const { key, url } = spaceToday(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<TodayDto>(url), refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.recons.some((r) => r.running) ? LIVE_RUN_POLL_MS : LIVE_POLL_MS) });
}

/** A recon's Live day, polled as Today; `enabled` once it has a published version (409 before). */
export function useReconLive(spaceId: string, id: string, enabled: boolean) {
  const { key, url } = reconLive(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<ReconLiveDto>(url), enabled, retry: retryUnlessNotFound, refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.recon.running ? LIVE_RUN_POLL_MS : LIVE_POLL_MS) });
}

/**
 * What waits for the viewer's decision in the space: the inbox's first page as it opens, for its total (Today). Read at
 * most every MY_APPROVALS_POLL_MS (stale until then, so a window focus doesn't read it sooner), not on the live poll.
 */
export function useMyApprovals(spaceId: string) {
  const { key, url } = myApprovals(spaceId);
  return useQuery({ queryKey: key, queryFn: () => api<Page<ApprovalRowDto>>(url), staleTime: MY_APPROVALS_POLL_MS, refetchOnWindowFocus: true, refetchInterval: MY_APPROVALS_POLL_MS });
}

/** A recon's open unmatch items and their amount per currency (the queue's summary for it), polled as the live day. */
export function useOpenSummary(spaceId: string, id: string, enabled: boolean) {
  const { key, url } = reconOpenSummary(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<BreakSummaryDto>(url), enabled, refetchOnWindowFocus: true, refetchInterval: LIVE_POLL_MS });
}

/** A recon's last TREND_DAYS business dates; read again every minute (a day's numbers move once per run). */
export function useReconTrend(spaceId: string, id: string, enabled: boolean) {
  const { key, url } = reconTrend(spaceId, id);
  return useQuery({ queryKey: key, queryFn: () => api<ReconTrendDto>(url), enabled, retry: retryUnlessNotFound, refetchInterval: 60_000 });
}

/**
 * The dates a run or simulation of `spec` starts with, and why a range finds nothing (owner, 22 Nov: never a default
 * without data): from each side's record dates in the space's source list (suggestedReplay, replayGap). `suggested`
 * null while the list loads or when neither side has records; `gap(range)` null when both sides have records in it.
 */
export function useReplayDefault(spaceId: string, spec: Pick<ReconSpec, "sides">) {
  const options = useSourceOptions(spaceId).data?.items;
  const dates = ([0, 1] as const).map((i) => (options ? recordDates(options.find((o) => o.id === spec.sides[i].source_id)) : null));
  const [today] = useState(() => appDate(Date.now())); // read once: a render stays pure
  const suggested = suggestedReplay(dates[0]!, dates[1]!, today);
  const gap = (range: DateRange) => (dates[0] && dates[1]
    ? replayGap(range, [{ label: spec.sides[0].label, dates: dates[0] }, { label: spec.sides[1].label, dates: dates[1] }]) : null);
  return { suggested, gap };
}
