"use client";

// A recon's Overview (owner, 22 Nov: as a source's, few tabs, details merged), in four zones (audit R2, LiveDay):
// Today (its business date's numbers, the Run card: how it is scheduled, how its day closes, its last and next run, a
// manual run), Needs action (open unmatch by reason, the sign-off of closed days), How it works (the day's pipeline
// with its sources) and History (the last runs, more on request, and the last TREND_DAYS dates), quiet and last.
// What it is (sides, passes, settings) is the Configuration tab.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart, CHART_HEIGHT } from "@starterkit/ui/charts";
import { CategoryChip, EmptyState, Facts, LazyMount, Panel, RelativeTime, ScrollFade } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon, ColumnChartIcon, ComponentsIcon, LogIcon, SpinnerIcon, TimeIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDto, ReconRunDto } from "@starterkit/shared/contracts/recon";
import { mayDo } from "@starterkit/shared/spaces";
import { LazyConfirmActionDialog } from "@/components/lazy-confirm";
import { StateChip } from "@/components/state-chip";
import { api, errorText } from "@/lib/client/api";
import { ENGINE_KEY } from "@/lib/shared/queries";
import { RUN_PAGE, reconLastTick, reconRunsFirst } from "@/lib/shared/queries-recon";
import { LiveDay } from "./live-day";
import { nextRunText, scheduleLine, totalsOfDay } from "./live-model";
import { RunControl } from "./run-control";
import { directionText, type Fields, settingsFacts } from "./spec-model";
import { recordFields } from "@starterkit/shared/recon";
import { rangeText, rateText, rollbackCover, runChip, runRowChips } from "./run-model";
import { at } from "./recon-text";
import { reconApi, reconRunHref, useReconTrend, useRollbackRun, useSideSource, useSpaceRoles } from "./use-recons";

const day = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

/**
 * How it runs, how its day closes, its last run, when the next one is due and, for an operator or a config maker, a run
 * of chosen dates, pinned to the card's foot. `scheduledAt`: when the last scheduled run started.
 */
function RunCard({ spaceId, id, r, runner, last, scheduledAt }: { spaceId: string; id: string; r: ReconDto; runner: boolean; last: ReconRunDto | undefined; scheduledAt: string | null }) {
  const spec = r.published!.spec;
  const sa = useSideSource(spaceId, spec.sides[0].source_id), sb = useSideSource(spaceId, spec.sides[1].source_id);
  const specA = sa.data?.published?.spec ?? null, specB = sb.data?.published?.spec ?? null;
  const fields: Fields = useMemo(() => [specA ? recordFields(specA) : null, specB ? recordFields(specB) : null], [specA, specB]);
  // the clock is read after mount (the server's would differ) and every 30 s; the line keeps its height meanwhile
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Panel icon={TimeIcon} title="Run" description={scheduleLine(spec.schedule)} className="h-full" bodyClassName="flex flex-col">
      <div className="flex flex-1 flex-col gap-4">
        <Facts items={[
          // the version review's words (settingsFacts); the schedule is the card's description
          ...settingsFacts(spec, fields).filter((f) => f.key !== "schedule").map((f): [string, string] => [f.label, f.text]),
          ["Direction", directionText(spec)],
          ["Last run", last ? (
            <span className="flex flex-wrap items-center gap-2">
              <StateChip chip={runChip(last)} />
              <RelativeTime at={Date.parse(last.startedAt)} touchDate={false} />
              <Link className="inline-flex items-center gap-1 text-fg underline-offset-4 hover:underline" href={reconRunHref(spaceId, id, last.id)}>Open results<Icon icon={ArrowRightIcon} size={14} /></Link>
            </span>
          ) : "No run yet"],
        ]} />
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          {/* no live region: the line is read again every 30 s, and a due time is not news to announce */}
          <p className="min-h-5 text-body-sm text-fg-2">{now != null && nextRunText(spec.schedule, scheduledAt, now)}</p>
          {runner
            ? <RunControl spaceId={spaceId} id={id} spec={spec} />
            : <p className="text-body-sm text-fg-3">Operators and config makers start a run of chosen dates.</p>}
        </div>
      </div>
    </Panel>
  );
}

/** "12 in · 10 matched · 2 waiting" of a run's own counters (what it did). */
function countsOf(r: ReconRunDto): string {
  const c = r.counters, inItems = c.intake.a + c.intake.b;
  const matched = Object.values(c.passes).reduce((n, p) => n + p.matched, 0), waiting = c.open.a + c.open.b;
  return [`${formatNumber(inItems)} in`, `${formatNumber(matched)} matched`, waiting ? `${formatNumber(waiting)} waiting` : ""].filter(Boolean).join(" · ");
}

/** Rows the run history shows until "Show all" (audit §5.9). */
const HISTORY_ROWS = 5;

/**
 * The recon's runs, newest first, the last HISTORY_ROWS until "Show all"; then older pages load as the end comes into
 * view. Quiet: history reads after the page's summary and actions.
 */
function RunHistory({ spaceId, id }: { spaceId: string; id: string }) {
  const [all, setAll] = useState(false);
  // a space admin rolls back from a run (owner, 26 Nov): it and every live run after it, then their dates run again
  const admin = mayDo(useSpaceRoles(spaceId), "rollbackRun");
  const undo = useRollbackRun(spaceId, id);
  const [asking, setAsking] = useState<ReconRunDto | null>(null);
  const firstQ = reconRunsFirst(spaceId, id);
  const first = useQuery({ queryKey: firstQ.key, queryFn: () => api<Page<ReconRunDto>>(firstQ.url), refetchInterval: 30_000 });
  const q = useInfiniteQuery({
    queryKey: [ENGINE_KEY[0], "runs-older", spaceId, id],
    queryFn: ({ pageParam }) => api<Page<ReconRunDto>>(reconApi(spaceId, id, `/runs?page=${pageParam}&pageSize=${RUN_PAGE}`)),
    initialPageParam: 2, enabled: false,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total && last.page < 1000 ? last.page + 1 : undefined),
  });
  const end = useRef<HTMLLIElement>(null);
  const f = first.data;
  const hasNextPage = all && (q.data ? q.hasNextPage : !!f && f.pageSize < f.total);
  const { isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage) return;
    const o = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: "120px" });
    o.observe(el);
    return () => o.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const loaded = [...(f?.items ?? []), ...(q.data?.pages.flatMap((p) => p.items) ?? [])].filter((r, i, list) => list.findIndex((x) => x.id === r.id) === i);
  const runs = all ? loaded : loaded.slice(0, HISTORY_ROWS);
  const more = !all && (f?.total ?? 0) > HISTORY_ROWS;
  const cover = asking ? rollbackCover(asking, loaded) : null;
  return (
    <Panel flush tone="quiet" icon={LogIcon} title="Run history" count={f?.total} description="Newest first · scheduled, manual and simulations" className="flex min-h-72 flex-col" bodyClassName="flex flex-1 flex-col"
      actions={more ? <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>Show all</Button> : undefined}>
      <div className="relative min-h-64 flex-1">
        <div className="absolute inset-0"><ScrollFade className="h-full">
          <ol aria-label="Runs">
            {first.isError && !runs.length && <li className="p-4 text-body-sm text-down-ink">Couldn&apos;t load the runs. {errorText(first.error)}</li>}
            {first.isSuccess && !runs.length && <li><EmptyState icon={LogIcon} title="No runs yet" description="Each run lists here once the schedule or someone starts one." /></li>}
            {runs.map((r) => {
              const { chip, mode } = runRowChips(r);
              const offers = admin && !!rollbackCover(r, loaded);
              return (
                <li key={r.id} className="border-b border-line last:border-b-0">
                  <Link href={reconRunHref(spaceId, id, r.id)} className="grid gap-1 px-4 py-2.5 hover:bg-tray focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
                    <span className="flex flex-wrap items-center gap-2">
                      <StateChip chip={chip} />
                      {mode && <CategoryChip slot="neutral" label={mode} />}
                      {r.rolledBackAt && <CategoryChip slot="neutral" label="Rolled back" />}
                      <span className="text-body-sm text-fg">{rangeText(r.from, r.to)}</span>
                      <span className="ml-auto font-mono text-caption text-fg-3 tabular">{at(r.startedAt)}</span>
                    </span>
                    <span className="text-body-sm text-fg-2">{r.status === "failed" && r.error ? r.error : countsOf(r)}</span>
                    {r.rolledBackAt && <span className="text-caption text-fg-3">Rolled back {at(r.rolledBackAt)}: what it matched and broke was undone.</span>}
                    {r.rollbackOf && <span className="text-caption text-fg-3">Ran again after a rollback: undid the runs first, then matched their dates.</span>}
                  </Link>
                  {offers && (
                    <div className="px-4 pb-2.5">
                      <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(r)}>Roll back from here</Button>
                    </div>
                  )}
                </li>
              );
            })}
            {hasNextPage && <li ref={end} className="flex items-center gap-2 px-4 py-3 text-caption text-fg-3">{isFetchingNextPage && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Loading older runs</li>}
          </ol>
        </ScrollFade></div>
      </div>
      {asking && cover && (
        <LazyConfirmActionDialog open onOpenChange={(o) => { if (!o) setAsking(null); }} auditFields={false} reasons={[]} destructive
          title="Roll back runs"
          description={`The run of ${at(asking.startedAt)} and every run after it lose what they matched and the unmatch items they made: those items wait again, and whoever had one of them no longer does. A rerun with the published version, queued now, matches ${rangeText(cover.from, cover.to)} again. Use it after a run matched with a version or data that was wrong.`}
          impact={[
            `${formatNumber(cover.runs)} ${cover.runs === 1 ? "run" : "runs"} rolled back`,
            `${rangeText(cover.from, cover.to)} run again`,
            "Matches a person made, write-offs and postings stay",
            "A closed business date, or a change waiting for a decision, refuses the rollback; nothing changes then",
          ]}
          actionLabel="Roll back runs"
          onConfirm={async () => { await undo.mutateAsync(asking.id); setAsking(null); }} />
      )}
    </Panel>
  );
}

/** Matched, waiting and unmatch items of the last TREND_DAYS dates, with the latest match rate (a day that slipped shows). */
function Trend({ spaceId, id }: { spaceId: string; id: string }) {
  const q = useReconTrend(spaceId, id, true);
  const days = q.data?.days ?? [];
  if (!days.length) return null;
  const totals = days.map((d) => (d.day ? totalsOfDay(d.day) : null));
  const latest = [...totals].reverse().find((t) => t?.rate != null)?.rate ?? null;
  return (
    <Panel tone="quiet" icon={ColumnChartIcon} title={`Last ${days.length} days`} description={`Match rate ${rateText(latest)} on the latest date a run covered · items per business date`}>
      <LazyMount minHeight={CHART_HEIGHT.standard}>
        {/* matched and unmatch in their outcome slots, what still waits neutral (audit R4) */}
        <BarChart label="Matched, waiting and unmatch items per business date" categories={days.map((d) => day(d.date))} format={formatNumber} stacked
          series={[
            { label: "Matched", values: totals.map((t) => (t ? t.matched : 0)), slot: 0 },
            { label: "Waiting", values: totals.map((t) => (t ? t.waiting + t.suggested : 0)), tone: "neutral" as const, striped: true },
            { label: "Unmatch", values: totals.map((t) => (t ? t.breaks : 0)), slot: 1 },
            // a one-way recon's side B with no counterpart (DEC-055): no one's work, grey like its status
            ...(totals.some((t) => t?.notRequired) ? [{ label: "Not required", values: totals.map((t) => (t ? t.notRequired : 0)), tone: "neutral" as const }] : []),
          ]} />
      </LazyMount>
    </Panel>
  );
}

/**
 * The Overview of a recon with an approved version; before one, where to go (its draft is in Configuration).
 * `last` = its latest run (the Run card's line).
 */
// below the fold: its code loads after the page (bundle budget, DEC-040); its rows are prefetched with the page
const SignoffTable = dynamic(() => import("./signoff-table").then((m) => m.SignoffTable), { ssr: false, loading: () => <div aria-hidden="true" className="h-64" /> });
// the breakdown card's code too; its counts are prefetched with the page
const ReasonBreakdown = dynamic(() => import("./reason-breakdown").then((m) => m.ReasonBreakdown), { ssr: false, loading: () => <div aria-hidden="true" className="h-64" /> });

export function ReconOverview({ spaceId, id, r, runner, configHref }: { spaceId: string; id: string; r: ReconDto; runner: boolean; configHref: string }) {
  const firstQ = reconRunsFirst(spaceId, id);
  const runs = useQuery({ queryKey: firstQ.key, queryFn: () => api<Page<ReconRunDto>>(firstQ.url), enabled: !!r.published, refetchInterval: 30_000 });
  // the last scheduled start of a recon whose window runs more than once (ticks) from its own read: the first page of
  // every run can hold none of them
  const tickQ = reconLastTick(spaceId, id);
  const s = r.published?.spec.schedule;
  const ticks = useQuery({ queryKey: tickQ.key, queryFn: () => api<Page<ReconRunDto>>(tickQ.url), enabled: !!s && s.from !== s.to, refetchInterval: 30_000 });
  if (!r.published) {
    return (
      <Panel><EmptyState icon={ComponentsIcon} title="Not running yet" description="The recon runs once a config checker approves its first version. Its draft, passes and simulation are in Configuration."
        action={<Link className="text-primary underline-offset-4 hover:underline" href={configHref}>Open configuration</Link>} /></Panel>
    );
  }
  const last = runs.data?.items.find((x) => x.mode !== "simulation");
  return (
    <LiveDay spaceId={spaceId} id={id} spec={r.published.spec}
      run={<RunCard spaceId={spaceId} id={id} r={r} runner={runner} last={last} scheduledAt={ticks.data?.items[0]?.startedAt ?? null} />}
      act={
        <div className="grid items-stretch gap-gutter xl:grid-cols-3">
          <ReasonBreakdown spaceId={spaceId} id={id} />
          <div className="grid min-w-0 gap-gutter xl:col-span-2"><SignoffTable spaceId={spaceId} id={id} /></div>
        </div>
      }
      history={
        <div className="grid items-stretch gap-gutter xl:grid-cols-2">
          <RunHistory spaceId={spaceId} id={id} />
          <Trend spaceId={spaceId} id={id} />
        </div>
      } />
  );
}
