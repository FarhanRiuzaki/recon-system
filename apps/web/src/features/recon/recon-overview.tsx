"use client";

// A recon's Overview (owner, 22 Nov: as a source's, few tabs, details merged): how it runs. Its business date's numbers,
// the Run card (how it is scheduled, how its day closes, its last run, a manual run) beside its Run history (newest
// first, as tall as the card, older runs load as the list scrolls), the last TREND_DAYS dates, then the day's pipeline
// and the sources (LiveDay). What it is (sides, passes, settings) is the Configuration tab.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { BarChart, CHART_HEIGHT } from "@starterkit/ui/charts";
import { EmptyState, LazyMount, Panel, RelativeTime, ScrollFade, StatusChip } from "@starterkit/ui/ds";
import { APP_TIME_ZONE_LABEL, formatDate, formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { ColumnChartIcon, ComponentsIcon, LogIcon, SpinnerIcon, TimeIcon } from "@starterkit/ui/ui/icons";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDto, ReconRunDto } from "@starterkit/shared/contracts/recon";
import { api, errorText } from "@/lib/client/api";
import { ENGINE_KEY, RUN_PAGE, reconRunsFirst } from "@/lib/shared/queries";
import { LiveDay } from "./live-day";
import { scheduleLine, totalsOfDay } from "./live-model";
import { RunControl } from "./run-control";
import { isLive, rangeText, rateText, STOPPED_CHIP } from "./run-model";
import { at } from "./recon-text";
import { reconApi, reconRunHref, useReconTrend } from "./use-recons";

const MODE: Record<ReconRunDto["mode"], string> = { tick: "Scheduled", daily: "Scheduled", manual: "Manual", rerun: "Rerun", simulation: "Simulation" };
const chipOf = (r: ReconRunDto) => (isLive(r) ? { health: "unknown" as const, label: r.status === "queued" ? "Queued" : "Running" }
  : r.status === "failed" ? STOPPED_CHIP : { health: "healthy" as const, label: r.mode === "simulation" ? "Simulated" : "Done" });
const day = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

/** Label / value rows of a card (as the source's Pull card). */
function Rows({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 md:grid-cols-[9rem_minmax(0,1fr)]">
      {items.map(([k, v]) => <div key={k} className="contents"><dt className="text-label text-fg">{k}</dt><dd className="min-w-0 text-body-sm text-fg-2">{v}</dd></div>)}
    </dl>
  );
}

/** How it runs, how its day closes, its last run and, for an operator or a config maker, a run of chosen dates. */
function RunCard({ spaceId, id, r, runner, last }: { spaceId: string; id: string; r: ReconDto; runner: boolean; last: ReconRunDto | undefined }) {
  const spec = r.published!.spec;
  return (
    <Panel icon={TimeIcon} title="Run" description={scheduleLine(spec.schedule)}>
      <div className="grid gap-4">
        <Rows items={[
          ["Day closes", `${spec.close_at} ${APP_TIME_ZONE_LABEL}; open items then become breaks`],
          ["Grace", `${spec.grace_minutes} min after the other side is complete`],
          ["Carry over", spec.carry_over_days ? `${spec.carry_over_days} ${spec.carry_over_days === 1 ? "day" : "days"}: earlier breaks can still pair` : "None: each day stands alone"],
          ["Last run", last ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip health={chipOf(last).health} label={chipOf(last).label} />
              <RelativeTime at={Date.parse(last.startedAt)} touchDate={false} />
              <Link className="text-fg underline-offset-4 hover:underline" href={reconRunHref(spaceId, id, last.id)}>Open results</Link>
            </span>
          ) : "No run yet"],
        ]} />
        {runner
          ? <div className="border-t border-line pt-4"><RunControl spaceId={spaceId} id={id} spec={spec} /></div>
          : <p className="border-t border-line pt-4 text-body-sm text-fg-3">Operators and config makers start a run of chosen dates; the schedule runs it meanwhile.</p>}
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

/** The recon's runs, newest first, beside the Run card and as tall as it; older pages load as the end comes into view. */
function RunHistory({ spaceId, id }: { spaceId: string; id: string }) {
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
  const hasNextPage = q.data ? q.hasNextPage : !!f && f.pageSize < f.total;
  const { isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage) return;
    const o = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: "120px" });
    o.observe(el);
    return () => o.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const runs = [...(f?.items ?? []), ...(q.data?.pages.flatMap((p) => p.items) ?? [])].filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
  return (
    <Panel flush icon={LogIcon} title="Run history" count={f?.total} description="Newest first · scheduled, manual and simulations" className="flex min-h-72 flex-col" bodyClassName="flex flex-1 flex-col">
      <div className="relative min-h-64 flex-1">
        <div className="absolute inset-0"><ScrollFade className="h-full">
          <ol aria-label="Runs">
            {first.isError && !runs.length && <li className="p-4 text-body-sm text-down-ink">Couldn&apos;t load the runs. {errorText(first.error)}</li>}
            {first.isSuccess && !runs.length && <li><EmptyState icon={LogIcon} title="No runs yet" description="Each run lists here once the schedule or someone starts one." /></li>}
            {runs.map((r) => {
              const chip = chipOf(r);
              return (
                <li key={r.id} className="border-b border-line last:border-b-0">
                  <Link href={reconRunHref(spaceId, id, r.id)} className="grid gap-1 px-4 py-2.5 hover:bg-tray focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusChip health={chip.health} label={chip.label} />
                      <span className="text-body-sm text-fg">{MODE[r.mode]} · {rangeText(r.from, r.to)}</span>
                      <span className="ml-auto font-mono text-caption text-fg-3 tabular">{at(r.startedAt)}</span>
                    </span>
                    <span className="text-body-sm text-fg-2">{r.status === "failed" && r.error ? r.error : countsOf(r)}</span>
                  </Link>
                </li>
              );
            })}
            {hasNextPage && <li ref={end} className="flex items-center gap-2 px-4 py-3 text-caption text-fg-3">{isFetchingNextPage && <Icon icon={SpinnerIcon} className="motion-safe:animate-spin" />}Loading older runs</li>}
          </ol>
        </ScrollFade></div>
      </div>
    </Panel>
  );
}

/** Matched, waiting and broken items of the last TREND_DAYS dates, with the latest match rate (a day that slipped shows). */
function Trend({ spaceId, id }: { spaceId: string; id: string }) {
  const q = useReconTrend(spaceId, id, true);
  const days = q.data?.days ?? [];
  if (!days.length) return null;
  const totals = days.map((d) => (d.day ? totalsOfDay(d.day) : null));
  const latest = [...totals].reverse().find((t) => t?.rate != null)?.rate ?? null;
  return (
    <Panel icon={ColumnChartIcon} title={`Last ${days.length} days`} description={`Match rate ${rateText(latest)} on the latest date a run covered · items per business date`}>
      <LazyMount minHeight={CHART_HEIGHT.standard}>
        <BarChart label="Matched, waiting and broken items per business date" categories={days.map((d) => day(d.date))} format={formatNumber} stacked
          series={[
            { label: "Matched", values: totals.map((t) => (t ? t.matched : 0)), slot: 0 },
            { label: "Waiting", values: totals.map((t) => (t ? t.waiting + t.suggested : 0)), slot: 2 },
            { label: "Breaks", values: totals.map((t) => (t ? t.breaks : 0)), tone: "down" as const },
          ]} />
      </LazyMount>
    </Panel>
  );
}

/**
 * The Overview of a recon with an approved version; before one, where to go (its draft is in Configuration).
 * `last` = its latest run (the Run card's line).
 */
export function ReconOverview({ spaceId, id, r, runner, configHref }: { spaceId: string; id: string; r: ReconDto; runner: boolean; configHref: string }) {
  const firstQ = reconRunsFirst(spaceId, id);
  const runs = useQuery({ queryKey: firstQ.key, queryFn: () => api<Page<ReconRunDto>>(firstQ.url), enabled: !!r.published, refetchInterval: 30_000 });
  if (!r.published) {
    return (
      <Panel><EmptyState icon={ComponentsIcon} title="Not running yet" description="The recon runs once a config checker approves its first version. Its draft, passes and simulation are in Configuration."
        action={<Link className="text-primary underline-offset-4 hover:underline" href={configHref}>Open configuration</Link>} /></Panel>
    );
  }
  const last = runs.data?.items.find((x) => x.mode !== "simulation");
  return (
    <LiveDay spaceId={spaceId} id={id} spec={r.published.spec} between={
      <>
        {/* the Run card and its history side by side, the history as tall as the card (as a source's Pull) */}
        <div className="grid items-stretch gap-section xl:grid-cols-2">
          <RunCard spaceId={spaceId} id={id} r={r} runner={runner} last={last} />
          <RunHistory spaceId={spaceId} id={id} />
        </div>
        <Trend spaceId={spaceId} id={id} />
      </>
    } />
  );
}
